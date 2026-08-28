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

### What it still needs from you

1. **A remote.** This repo is local-only. The pipeline has nothing to trigger
   from until it is pushed somewhere.

2. **An Azure DevOps login.** `az devops` needs its own auth, separate from
   `az login`:

   ```powershell
   az devops login --organization https://dev.azure.com/<your-org>
   ```

   It will ask for a Personal Access Token. Create one at
   `https://dev.azure.com/<your-org>/_usersSettings/tokens` with **Code
   (read & write)**, **Build (read & execute)** and **Service Connections
   (read, query & manage)**.

3. **An ARM service connection** named to match `azureSubscription` in the
   YAML (`rustipede-arm`). Easiest from the DevOps UI: *Project settings →
   Service connections → New → Azure Resource Manager → Workload identity
   federation*. Creating it from the CLI needs a service principal, which
   needs directory permissions a personal account often does not have.

4. **GameBase on disk.** The game references it *by path* (see
   `vite.config.ts`), so a hosted build agent needs it checked out alongside
   this repo, or the packages published to the feed and the aliases swapped
   for dependencies.

Point 4 is the one that will actually stop the pipeline first, and it is a
decision rather than a chore: path references are right while you are changing
both sides at once, and wrong the moment the build leaves this machine.

## Undo

```powershell
az group delete --name rustipede-rg --yes
```

Removes the app, the plan and the group. Billing stops with it.
