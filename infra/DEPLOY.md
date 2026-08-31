# Deploying Rustipede

Two scripts and a pipeline. `provision.ps1` owns the infrastructure,
`azure-pipelines.yml` owns build-and-ship, and they stay separate on purpose:
provisioning from the pipeline means every push reasserts your infrastructure,
which is how a setting you fixed by hand silently reverts mid-week.

## Why App Service and not Static Web Apps

Co-op needs the relay, and the relay is an ASP.NET Core server holding a
WebSocket open per player. Static Web Apps back onto HTTP-triggered Azure
Functions, which cannot hold a socket. On SWA the game would load and co-op
would be dead.

App Service serves the client and the relay from one origin, which is what the
client expects: it builds the socket URL from `document.baseURI`, so the page
and `/ws/mp` must share a host and a path prefix.

## One command

```powershell
./infra/provision.ps1 -Deploy
```

Idempotent. Re-running is the intended way to reapply settings after someone
has been in the portal. `-WhatIf` shows the plan and changes nothing.

### Sharing a plan you already pay for

```powershell
./infra/provision.ps1 -PlanName max12charact-servplan -PlanResourceGroup max12charact_group -Deploy
```

A plan that already exists is **adopted** rather than created: its region and
tier are read, not asserted, because it is someone else's resource and other
apps are living on it. The app follows the plan's region — an app may sit in a
different resource group from its plan, but never a different region.

Two things get checked on the way in, because both fail confusingly:

- **The plan's OS.** A plan is Linux or Windows for life and the app has to
  match. Adopting a Windows plan stops with a sentence saying so, rather than
  a create failure about site kinds.
- **The plan's instance count.** Every app on a plan runs on every instance,
  and the relay keeps its lobby registry in memory — so above capacity 1, two
  players can land on different instances and never pair, intermittently, with
  nothing in either log explaining it. The script warns if the count ever
  moves above one.

It also prints the neighbours it is sharing with. A B1 is one small VM between
all of them, so if the site feels sluggish under load, that shared core is the
first place to look.

## The three settings that are not the default

The portal will not warn you about any of these, and each fails in a way that
looks like something else.

**WebSockets are off by default.** With them off the lobby opens, the socket
never connects, and *nothing appears in the server log* — because the request
never reaches the app. This looks exactly like a client bug.

**One worker, always.** The relay keeps its lobby registry in memory and pairs
sockets in-process. On two instances, two players can land on different ones
and never see each other's lobby — intermittently, with nothing wrong in
either log. So the plan is pinned to a single worker. This is a real ceiling:
scaling out needs the relay's lobby state moved somewhere shared first.

**Always On.** Without it the app unloads when idle and the next visitor waits
through a cold start, which drops any WebSocket mid-handshake. F1 does not
have it, which is why B1 is the floor for something you would actually invite
someone to play on.

## The CLI calls a slow start a failed one

`az webapp deploy` tracks the site's startup and reports on it, and on a cold
start it gets the answer wrong. Measured here, on one deploy:

| source | verdict |
|---|---|
| `az webapp deploy` | polled 876s, then **"Site failed to start"**, exit 1 |
| the container log | `Site startup probe succeeded after 144.98 seconds` / `Site started.` |
| the site itself | **200**, ten times over thirty seconds |
| `/ws/mp` | 400 — the relay was up too |

The site had been serving for six minutes by the time the CLI declared it
dead. A false failure is worse than no check at all: it sends you hunting a
crash that never happened, and it fails the script -- which in a pipeline
fails the build over a healthy deploy.

So the deploy passes `--track-status false` and this script asks the site
itself instead: poll `/` until it answers 200 (up to ten minutes, because a
cold start on a plan shared with six other apps genuinely is slow), then
require **400** from `/ws/mp`. That second one is the half that breaks
quietly -- WebSockets are off by default on App Service, and when they are off
nothing appears in the log because the request never reaches the app. 400
means the endpoint exists and refused a non-WebSocket request; 404 means the
app is not routing it.

It is the same probe `azure-pipelines.yml` runs after its deploy, which is not
a coincidence -- it is the question `--track-status` was approximating.

## The wrong account is worse than no account

`az` picks a default subscription, and it re-picks silently the moment a new
tenant appears on the sign-in -- a service connection, an invitation, anything.
It happened here: the default became a **tenant-level account**, a sign-in with
no subscription behind it.

What makes that dangerous is not the error it eventually throws. It is that
every probe in this script reads as *not there* first: the resource group is
missing, the web app is missing, the hostname is free. So the script does not
stop, it starts **building**. Landing on a tenant with no subscription merely
errors out; landing on the wrong *real* subscription would quietly stand up a
second copy of the whole deployment next to the one you already have.

The preflight now refuses a tenant-level account -- the one whose subscription
id **is** its tenant id, which is the cheapest reliable tell -- and prints the
subscriptions you could have meant, as commands you can paste:

```
Signed in to a TENANT-LEVEL account -- 'N/A(tenant level account)' -- which owns no subscription.
Every check below would read as 'not there' and this script would start creating things.
Name the subscription you mean:
  ./infra/provision.ps1 -Subscription f2f0bf15-...   # Azure subscription 1
```

Every successful run also prints the subscription id it is acting on, under the
account name, because the name alone does not distinguish two subscriptions
called the same thing.

If you have more than one tenant, pass `-Subscription` and stop thinking about
it.

## Quota, and the error that does not say "region"

App Service quota is granted **per region**, and a subscription can sit at
zero in one region while being fine in the next. The failure reads:

```
Operation cannot be completed without additional quota.
Current Limit (Total VMs): 0
```

It says nothing about regions, which sends people to open a support ticket
they usually do not need. On this subscription `eastus` is at zero while
`westus2` and `centralus` are fine, which is why the default is `westus2`.
`westeurope` refuses separately, as a region "not accepting new customers".

If a region is blocked:

```powershell
./infra/provision.ps1 -Location centralus -Deploy
```

## Logging the run, and the trap that hides in it

```powershell
./infra/provision.ps1 -Deploy > provision.log 2>&1
```

That is safe now, and it was not always. Windows PowerShell wraps anything a
native command writes to **stderr** in an ErrorRecord as soon as the output is
captured, and with `$ErrorActionPreference = "Stop"` that record terminates the
script. The Azure CLI writes ordinary progress notes to stderr — `az webapp
create` signs off with *"Webapp created. Deploy your code with: az webapp
deploy"* — so redirecting the run into a log file killed it on the strength of
a **success** message, half way through provisioning, leaving a resource group
and a bare web app with no settings and no code on them.

`Invoke-Az` now drops to `Continue` around the call and gates on
`$LASTEXITCODE`, which is the only honest success signal for a native command;
`Get-AzJson` has always done the same for probes that are allowed to come back
empty. Both are proven against a command that warns on stderr and exits 0, and
against one that genuinely fails.

The same trap is why `az` output should never be piped through `Select-String`
to trim it — a filter captures, and capturing is the trigger.

## Where the client ends up

Locally the server sits beside the client and reads `../dist` with no copy
step. A published build has no `../dist` — App Service deploys the publish
root and nothing above it — so the client is folded into `wwwroot` inside that
root instead. `Program.cs` probes `wwwroot` first and `../dist` second, and
says which paths it tried if it finds neither.

Getting this wrong used to take the whole site down at startup, because
`PhysicalFileProvider` throws on a missing directory and the exception says
nothing about the real problem.

## The pipeline

`azure-pipelines.yml` builds, typechecks, runs `npm run check` (the
determinism proof — two co-op clients over a simulated laggy link, so a change
that would desync two players fails the build rather than the match), then
publishes and deploys.

It ends by probing `/ws/mp` and asserting **400**. A deploy returning 200 has
proved the site is up; it has not proved the relay is up, and the relay is the
half that breaks silently. A plain GET to the socket path answering 400 means
"the endpoint exists and refused a non-WebSocket request" — which is the
cheapest possible proof that co-op will work.

### The two repositories

The build needs **GameBase on disk beside this one**, because the game
references it by path: `vite.config.ts` aliases `@ccllc/*` into
`../../../GameBase/GameBase/packages`, and `server/Server.csproj` walks four
levels out of `server/` to the relay. Both land on the same directory, three
above the game.

So the pipeline checks out two repositories and *places* them:

| repository | `path:` |
|---|---|
| self | `Games/Centipede/TypeScript` |
| GameBase | `GameBase/GameBase` |

Three levels up from the first is the shared root, and the second is under it
exactly where both references already look. Nothing in the game changes.

Two consequences worth knowing:

- **Every script step names its working directory.** With more than one
  repository the default is the shared root, not either repository.
- **Only this repo runs `npm ci`.** GameBase is consumed as *source* through
  the vite aliases, and the one thing those sources import from outside
  themselves is React, which is already a dependency here. Installing
  GameBase's own workspace would put a second React in the tree — the exact
  thing `resolve.dedupe` exists to undo.

This layout is not theoretical: it was reproduced locally (clone both to those
paths, then `npm ci`, `npm run typecheck`, `npm run check`, `npm run build`,
`dotnet publish server`) and every step passed, producing a client bundle
byte-identical to the deployed one.

The pipeline pins GameBase to `refs/heads/dev`, which is what the game is
developed and verified against; `main` trails it. Pin it to a commit if you
want the build frozen — but then CI stops telling you when GameBase breaks the
game, which is most of what it is for.

### GameBase is mirrored into this organisation

GameBase is developed at `https://ccllc.visualstudio.com/Games/_git/GameBase`,
in a **different** Azure DevOps organisation. A build's own token does not
cross that boundary, and both cross-organisation options are awkward here: a
Personal Access Token would have to be minted by whichever account can read
`ccllc` -- not the one you use for Azure, they are different identities -- and
the PAT-free Entra alternative needs both organisations on one tenant, which
these are not.

So a mirror lives beside this repo instead, at
`https://dev.azure.com/MorrisonHotel/Centipede/_git/GameBase`, and the pipeline
reads that. **No service connection is involved at all**, and a second thing
falls out of it: repository-resource triggers only fire within an
organisation, so mirroring is what makes the trigger below possible.

#### Refreshing it

The mirror does not update itself. After changes land in GameBase upstream:

```powershell
git -C C:\Users\sledz\source\GameBase\GameBase fetch origin --prune
git -C C:\Users\sledz\source\GameBase\GameBase push https://dev.azure.com/MorrisonHotel/Centipede/_git/GameBase origin/main:refs/heads/main origin/dev:refs/heads/dev
```

It pushes the **remote-tracking** refs, not your local branches, so the mirror
reflects what is actually upstream rather than whatever you happen to have
checked out. Adding `mirror` as a named remote in the GameBase checkout would
shorten this; it is spelled out in full because it touches a repository
outside this project.

Refreshing it **runs this pipeline** -- the trigger on the repository resource
fires on `dev`. That is the point: the README has always said to re-run
`npm run check` and `npm run typecheck` after pulling GameBase, because they
are cheap and they are what catches a breaking change. Now it is automatic.

It does **not** deploy. A run triggered by another repository takes
`Build.SourceBranch` from *that* repository, so it arrives as `refs/heads/dev`
and the Deploy stage -- which insists on `refs/heads/main` -- is skipped.
GameBase can prove the game still works without being able to ship it.

#### The trade

A mirror is a copy, and a copy goes stale silently. A build that passes
against a GameBase three weeks behind has told you nothing about the GameBase
on your disk. Nothing here detects that: refreshing is a habit, not a
mechanism. The alternative was a cross-organisation token, which goes wrong
loudly rather than quietly, but has to be created, held and rotated by an
account that is not the one running Azure.

### The first run parks until the GameBase repository is authorized

A pipeline that checks out a *second* repository stops on a **resource
authorization checkpoint** the first time it runs, and waits. This is the
single most misleading state in the whole setup: the run sits at
`notStarted` indefinitely and looks exactly like it is waiting for a build
agent. The tell is in the run's timeline, which reads
`Checkpoint.Authorization: inProgress`.

In the browser it is one click -- open the run, **View** -> **Permit**. From
the CLI:

```powershell
az devops invoke --org https://dev.azure.com/MorrisonHotel `
  --area pipelinePermissions --resource pipelinePermissions `
  --route-parameters project=Centipede resourceType=repository `
    resourceId="<projectId>.<repositoryId>" `
  --http-method PATCH --api-version "7.1-preview" --in-file perm.json
```

with `perm.json` holding `{"pipelines":[{"id":22,"authorized":true}]}`. It is
asked once, and every queued run releases at the same moment.

#### The api-version rule that makes `az devops invoke` usable

This is worth its own heading, because two of the three obvious spellings
fail and each fails differently:

| `--api-version` | what happens |
|---|---|
| `7.1-preview.1` | CLI crash. It rewrites the string to `7.1.1` and calls `float()` on it |
| `7.1` | *"The requested version of the resource is under preview. The -preview flag must be..."* |
| `7.1-preview` | **works** |

So: bare `-preview`, no trailing `.N`. Non-preview resources (the environments
endpoint below) take a plain `7.1`. When a call fails, read which of those two
errors you got -- they point in opposite directions.

`az rest` is no use for any of this. The token from
`az account get-access-token --resource 499b84ac-...` is refused by
`dev.azure.com`, which answers with an HTML sign-in page under an HTTP **200**
-- so the call fails as a *success*, with an empty body and no error.

### Validation is whole-pipeline, and it happens before any job

This is the trap that cost four runs. A stage naming a service connection or
an environment that does not exist fails **the entire pipeline** at compile
time -- so the Build stage never ran and no run said a word about the game.
`stagesToSkip` does not help: it skips execution, not validation.

That is why the Deploy stage sits behind `${{ if parameters.deploy }}`. A
`${{ }}` is evaluated before validation, so when it is off the stage is not in
the YAML being validated at all, and everything that needs no credentials runs
regardless. Flip the parameter's default once `rustipede-arm` exists, or tick
the box on a manual run.

The `rustipede-production` environment the deployment job names had to be
created too. `az` can do it, but only away from the paths that look obvious:

```powershell
az devops invoke --org https://dev.azure.com/MorrisonHotel --area distributedtask --resource environments --route-parameters project=Centipede --http-method POST --api-version 7.1 --in-file env.json
```

This one takes a plain `7.1` rather than the `7.1-preview` the authorization
call needs -- see the api-version table above, which is the difference between
a working command and one of two unhelpful errors.

### What it still needs from you

One thing, and it is a credential, so it is yours to create.

**`rustipede-arm`** -- an ARM service connection named to match
`azureSubscription` in the YAML. *Project settings -> Service connections ->
New -> Azure Resource Manager -> Workload identity federation*. Creating it
from the CLI needs a service principal, which needs directory permissions a
personal account often does not have.

It needs authorising for the pipeline the first time it runs: the run pauses
and offers a **permit** button on the run summary page, or you can
pre-authorise under the connection's *Security*.

You do **not** need `az devops login`. The `az devops` extension picks up the
`az login` credential, which is enough to list projects and repos, create a
repository, and create a pipeline.

## Undo

**Which command depends on who owns the plan**, and getting it wrong goes
badly in one direction or the other: deleting a plan that other apps live on,
or believing the billing stopped when it did not. The script prints the right
one for your setup at the end of every run.

If the game created its own plan, the group holds both and removing it stops
the charge:

```powershell
az group delete --name rustipede-rg --yes
```

If the game is sharing a plan (`-PlanName`), delete only the app. The plan
belongs to whatever else is running on it:

```powershell
az webapp delete --name rustipede --resource-group rustipede-rg
```

That leaves the plan and its other apps untouched — and note it does **not**
reduce your bill, because the plan was already being paid for. That is the
point of sharing one.

An empty plan left behind by a move still bills at its full tier. `az
appservice plan list --query "[?numberOfSites==\`0\`]"` finds them.
