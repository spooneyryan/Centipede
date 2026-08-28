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

### What it still needs from you

Both remaining items are **credentials**, so they are yours to create.

1. **A service connection to the GameBase organisation**, named
   `gamebase-repo`. GameBase lives at
   `https://ccllc.visualstudio.com/Games/_git/GameBase` — a *different*
   Azure DevOps organisation — and a build's own token is scoped to its own
   organisation, so it cannot reach across without one.

   *Project settings → Service connections → New → Azure Repos/Team
   Foundation Server*, connection URL `https://ccllc.visualstudio.com/`,
   authenticate with a Personal Access Token from **that** organisation
   (`https://ccllc.visualstudio.com/_usersSettings/tokens`) scoped to **Code
   (read)**. Name it `gamebase-repo` exactly — the YAML names it.

2. **An ARM service connection** named to match `azureSubscription` in the
   YAML (`rustipede-arm`). *Project settings → Service connections → New →
   Azure Resource Manager → Workload identity federation*. Creating it from
   the CLI needs a service principal, which needs directory permissions a
   personal account often does not have.

Both need authorising for the pipeline the first time it runs — the run pauses
and offers a "permit" button, or you can pre-authorise under each connection's
*Security*.

You do **not** need `az devops login`. The `az devops` extension picks up the
`az login` credential, which is enough to list projects and repos and to
create the pipeline; the PAT above is for the cross-organisation *fetch*, not
for the CLI.

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
