<#
.SYNOPSIS
  Create (or update) the Azure App Service that hosts Rustipede, and
  optionally publish the current working tree straight to it.

.DESCRIPTION
  Idempotent: every step checks before it creates, so re-running is safe and
  is in fact the intended way to reapply settings after someone has poked at
  them in the portal.

  Why App Service and not Static Web Apps: co-op needs the relay, which is an
  ASP.NET Core server holding a WebSocket per player. Static Web Apps back
  onto HTTP-triggered Functions and cannot hold a socket open, so the game
  would load and co-op would be dead. App Service serves the client and the
  relay from one origin, which is what the client's `document.baseURI`-relative
  /ws/mp expects.

  Three settings here are load-bearing and none of them are the default:

    WebSockets                off by default. Without it the lobby opens, the
                              socket never connects, and NOTHING appears in
                              the server log, because the request never
                              reaches the app.
    Exactly one worker        the relay keeps its lobby registry in memory. On
                              two instances, two players can land on different
                              ones and never pair, intermittently, for reasons
                              invisible from either end.
    Always On                 without it the app unloads when idle and the
                              next visitor waits through a cold start, which
                              drops any WebSocket mid-handshake.

.EXAMPLE
  ./infra/provision.ps1
  ./infra/provision.ps1 -Deploy
  ./infra/provision.ps1 -Name rustipede-ryan -Location westus2 -Deploy
  ./infra/provision.ps1 -WhatIf          # show the plan, change nothing
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    # Globally unique: it becomes <name>.azurewebsites.net.
    [string] $Name = "rustipede",
    [string] $ResourceGroup = "rustipede-rg",
    # westus2, not eastus: this subscription has an App Service quota of zero
    # in eastus, and the failure cascades into confusing "resource not found"
    # errors further down rather than saying so. Quota is per REGION, so the
    # fix is usually a different one rather than a support ticket.
    [string] $Location = "westus2",
    # B1 is the cheapest tier with Always On. F1 has neither Always On nor
    # enough concurrent sockets to be worth playing on.
    [ValidateSet("F1", "B1", "B2", "S1", "P0v3")]
    [string] $Sku = "B1",
    # An App Service plan to run on. If one by this name already exists it is
    # ADOPTED -- its region and tier win, and neither is touched -- so the game
    # can share a plan you are already paying for. Otherwise it is created.
    [string] $PlanName,
    # Where that plan lives, when it is not in $ResourceGroup. An app may sit
    # in a different resource group from its plan; it may not sit in a
    # different REGION, so adopting a plan moves the app to the plan's.
    [string] $PlanResourceGroup,
    [string] $Subscription,
    # Build and publish the working tree once provisioning is done.
    [switch] $Deploy
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

function Step($text) { Write-Host "`n=== $text" -ForegroundColor Cyan }
function Note($text) { Write-Host "    $text" -ForegroundColor DarkGray }
function Ok($text)   { Write-Host "    $text" -ForegroundColor Green }
function Warn($text) { Write-Host "    $text" -ForegroundColor Yellow }

# The az executable, resolved once and called by path from here on.
#
# PowerShell matches command names case-insensitively, so a helper function
# named `Az` shadows the `az` CLI -- and then every helper that shells out to
# `az` calls itself instead. Calling the resolved path makes that impossible
# however these helpers are named later.
$script:AzExe = (Get-Command az -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1).Source
if (-not $script:AzExe) { throw "The Azure CLI is not installed. See https://aka.ms/azure-cli" }

# Run an `az` command that MUST succeed.
#
# PowerShell does not raise on a native command's exit code, and
# $ErrorActionPreference does not change that -- so without this check a
# failed `az` prints its error and the script sails on announcing success.
# That is worse than crashing: the first run of this script reported creating
# a plan, a web app and six settings, none of which existed.
# It also has to survive the stderr trap Get-AzJson documents below, from the
# other side. With $ErrorActionPreference = "Stop", ANY stderr a native
# command produces becomes a terminating ErrorRecord the moment the output is
# captured -- and az writes ordinary progress notes there. `az webapp create`
# signs off with "Webapp created. Deploy your code with: az webapp deploy",
# so redirecting this script into a log file used to kill it half way through
# provisioning, on the strength of a success message. The exit code is the
# only honest signal, so gate on that and let the chatter through untouched.
function Invoke-Az {
    param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $Arguments)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { & $script:AzExe @Arguments }
    finally { $ErrorActionPreference = $previous }
    if ($LASTEXITCODE -ne 0) {
        throw "az $($Arguments -join ' ')`n  exited with code $LASTEXITCODE (see the error above)"
    }
}

# Run an `az` query that is ALLOWED to come back empty, and hand back parsed
# JSON or $null.
#
# Needed because of a Windows PowerShell trap: with $ErrorActionPreference =
# "Stop", anything a native executable writes to stderr is wrapped in an
# ErrorRecord and terminates the script. So `az webapp show` on a resource
# group that does not exist yet -- an ordinary "not there", exactly what a
# probe is for -- would kill the run instead of answering the question.
function Get-AzJson {
    param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $Arguments)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $out = & $script:AzExe @Arguments 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        if (-not $out) { return $null }
        return ($out | Out-String | ConvertFrom-Json)
    }
    catch { return $null }
    finally { $ErrorActionPreference = $previous }
}

# --- Preflight -------------------------------------------------------------
Step "Checking the Azure CLI"
if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw "The Azure CLI is not installed. See https://aka.ms/azure-cli"
}
$account = Get-AzJson account show
if (-not $account) { throw "Not signed in. Run: az login" }
if ($Subscription) {
    Invoke-Az account set --subscription $Subscription
    $account = Get-AzJson account show
}

# Refuse a TENANT-LEVEL account, which is a sign-in with no subscription behind
# it. `az` picks one of these as the default the moment a new tenant appears --
# a service connection, an invitation, anything -- and it does so silently.
#
# The failure it causes is the dangerous kind, because every probe below reads
# as "not there": the resource group is missing, the app is missing, the
# hostname is free. So the script does not stop, it starts BUILDING. Landing on
# a tenant with no subscription just errors; landing on the wrong real
# subscription would quietly stand up a second copy of the whole deployment.
#
# A tenant-level account is exactly the one whose subscription id IS its tenant
# id, which is the cheapest reliable tell.
if ($account.id -eq $account.tenantId) {
    $real = Get-AzJson account list --all --query "[?id!=tenantId].{name:name,id:id}"
    $lines = if ($real) { @($real) | ForEach-Object { "  ./infra/provision.ps1 -Subscription $($_.id)   # $($_.name)" } }
             else { @("  (az account list --all shows no real subscription; check az login)") }
    throw ("Signed in to a TENANT-LEVEL account -- '$($account.name)' -- which owns no subscription.`n" +
           "Every check below would read as 'not there' and this script would start creating things.`n" +
           "Name the subscription you mean:`n" + ($lines -join "`n"))
}
Ok "$($account.name)  ($($account.user.name))"
Note "subscription $($account.id)"

if (-not $PlanName) { $PlanName = "$Name-plan" }
if (-not $PlanResourceGroup) { $PlanResourceGroup = $ResourceGroup }
$plan = $PlanName

# `az webapp list` only sees what this subscription owns, but the HOSTNAME is
# global -- so a name someone else took fails at create time with a message
# that does not obviously say so. Check up front instead.
Step "Checking the name is available"
# The body goes through a file rather than inline: PowerShell 5.1 mangles
# embedded quotes on its way to a native executable, and az then reports the
# fragments as unrecognized arguments.
# Written through .NET rather than Set-Content because this has to happen even
# under -WhatIf: it is a read-only probe, and skipping it would leave the check
# reporting on a file that was never written.
$bodyFile = Join-Path ([System.IO.Path]::GetTempPath()) "rustipede-namecheck.json"
$body = @{ name = $Name; type = "Microsoft.Web/sites" } | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText($bodyFile, $body)
# Content-Type is not inferred from --body, and without it the API rejects the
# request as application/octet-stream.
$taken = Get-AzJson rest --method post `
    --url "https://management.azure.com/subscriptions/$($account.id)/providers/Microsoft.Web/checkNameAvailability?api-version=2023-12-01" `
    --headers "Content-Type=application/json" `
    --body "@$bodyFile"
[System.IO.File]::Delete($bodyFile)

$existing = Get-AzJson webapp show --name $Name --resource-group $ResourceGroup
if ($existing) {
    Ok "$Name already exists in $ResourceGroup -- updating it in place"
}
elseif ($taken -and -not $taken.nameAvailable) {
    throw "The hostname '$Name.azurewebsites.net' is taken ($($taken.message)). Pass a different -Name."
}
else {
    Ok "$Name.azurewebsites.net is free"
}

if ($WhatIfPreference) { Note "-WhatIf: nothing below will actually run." }

# --- Resource group --------------------------------------------------------
Step "Resource group: $ResourceGroup"
if ((az group exists --name $ResourceGroup) -eq "true") {
    Ok "already there"
}
elseif ($PSCmdlet.ShouldProcess($ResourceGroup, "create resource group in $Location")) {
    Invoke-Az group create --name $ResourceGroup --location $Location --output none
    Ok "created in $Location"
}

# --- App Service plan ------------------------------------------------------
Step "App Service plan: $plan"
$havePlan = Get-AzJson appservice plan show --name $plan --resource-group $PlanResourceGroup
$planId = $null
$adoptedPlan = [bool] $havePlan
$neighbourNames = @()

if ($havePlan) {
    # Adopt it. Its region and tier are facts about a resource someone else
    # may be relying on, so this reads them rather than asserting them.
    $planId = $havePlan.id
    $Location = $havePlan.location
    Ok "adopting the existing plan: $($havePlan.sku.name) in $($havePlan.location), $($PlanResourceGroup)"

    # A plan is Linux or Windows for life, and an app has to match. Catching
    # it here beats a create failure that talks about site kinds.
    $isLinux = ($havePlan.kind -like "*linux*") -or ($havePlan.reserved -eq $true)
    if (-not $isLinux) {
        throw "'$plan' is a Windows plan. This app publishes as DOTNETCORE|10.0 on Linux, " +
              "which cannot run on it. Use a Linux plan, or drop -PlanName to create one."
    }
    Ok "Linux plan, matches the app"

    # Every app on a plan runs on every instance of it, so the relay's
    # in-memory lobby registry only holds together at capacity 1. Above that,
    # two players can land on different instances and never pair -- and
    # nothing in either log says so.
    $capacity = [int] $havePlan.sku.capacity
    if ($capacity -gt 1) {
        Warn "This plan runs $capacity instances. The relay keeps its lobby"
        Warn "registry in memory, so players on different instances will not"
        Warn "see each other. Co-op needs this plan at capacity 1."
    }
    else {
        Ok "single instance, which is what the relay needs"
    }

    # Sharing is fine, but it is worth knowing what it is being shared with.
    $neighbours = Get-AzJson webapp list --query "[?serverFarmId=='$planId'].name"
    $neighbourNames = @($neighbours | Where-Object { $_ -ne $Name })
    if ($neighbourNames.Count -gt 0) {
        Note "sharing this plan with: $($neighbourNames -join ', ')"
        Note "$($havePlan.sku.name) is one small VM between all of them."
    }
}
elseif ($PSCmdlet.ShouldProcess($plan, "create $Sku Linux plan")) {
    try {
        Invoke-Az appservice plan create --name $plan --resource-group $PlanResourceGroup `
            --location $Location --sku $Sku --is-linux --output none
        Ok "created"
    }
    catch {
        # App Service quota is granted per region, and a subscription can sit
        # at zero in one region while being fine in the next. The raw message
        # says "additional quota" without saying that, which sends people to
        # open a support ticket they usually do not need.
        if ("$_" -match "quota") {
            Warn "No App Service quota in $Location on this subscription."
            Warn "Quota is per REGION. Try another one, e.g.:"
            Warn "  ./infra/provision.ps1 -Location centralus -Deploy"
            Warn "(westus2 and centralus were both usable when this was written.)"
        }
        throw
    }
    $planId = (Get-AzJson appservice plan show --name $plan --resource-group $PlanResourceGroup).id
}

# --- Web app ---------------------------------------------------------------
Step "Web app: $Name"
if ($existing) {
    Ok "already there"
}
elseif ($PSCmdlet.ShouldProcess($Name, "create web app on DOTNETCORE|10.0")) {
    # By plan RESOURCE ID rather than name, so the plan may live in another
    # resource group. The app inherits the plan's region either way.
    Invoke-Az webapp create --name $Name --resource-group $ResourceGroup --plan $planId `
        --runtime "DOTNETCORE:10.0" --output none
    Ok "created in $Location on $plan"
}

# --- The settings that actually matter -------------------------------------
Step "Applying the settings the defaults get wrong"
if ($PSCmdlet.ShouldProcess($Name, "enable WebSockets, pin to one worker, Always On, HTTPS only")) {

    # WebSockets. Without this the co-op lobby fails with nothing in the log.
    Invoke-Az webapp config set --name $Name --resource-group $ResourceGroup `
        --web-sockets-enabled true --output none
    Ok "WebSockets on"

    # One worker. The relay's lobby registry is in-process, so a second
    # instance is a second, invisible game world.
    Invoke-Az webapp config set --name $Name --resource-group $ResourceGroup `
        --number-of-workers 1 --output none
    Ok "pinned to a single worker (the relay is stateful in memory)"

    # Always On needs a tier that has it; F1 does not.
    if ($Sku -eq "F1") {
        Warn "F1 has no Always On: the app unloads when idle and the next"
        Warn "visitor waits through a cold start, dropping live sockets."
    }
    else {
        Invoke-Az webapp config set --name $Name --resource-group $ResourceGroup `
            --always-on true --output none
        Ok "Always On"
    }

    # wss:// rather than ws://, and no plaintext round trip first.
    Invoke-Az webapp update --name $Name --resource-group $ResourceGroup `
        --https-only true --output none
    Ok "HTTPS only"

    # ASPNETCORE_ENVIRONMENT so the app does not run in Development remotely.
    Invoke-Az webapp config appsettings set --name $Name --resource-group $ResourceGroup `
        --settings ASPNETCORE_ENVIRONMENT=Production --output none
    Ok "ASPNETCORE_ENVIRONMENT=Production"

    # Keep the deployment logs somewhere readable when something goes wrong.
    Invoke-Az webapp log config --name $Name --resource-group $ResourceGroup `
        --application-logging filesystem --level information --output none
    Ok "application logging on (az webapp log tail)"
}

# --- Optional: build and publish the working tree ---------------------------
if ($Deploy) {
    Step "Building"
    Push-Location $repo
    try {
        npm ci
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }

        $publish = Join-Path $repo "artifacts/publish"
        if (Test-Path $publish) { Remove-Item $publish -Recurse -Force }

        dotnet publish server -c Release -o $publish
        if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed" }

        # The client goes INSIDE the publish root: App Service deploys that
        # folder and nothing above it, so ../dist does not exist there.
        # Program.cs probes wwwroot first for exactly this reason.
        Copy-Item (Join-Path $repo "dist") (Join-Path $publish "wwwroot") -Recurse -Force
        Ok "client folded into wwwroot"

        # The zip is built entry by entry, with an explicit entry for every
        # DIRECTORY, because Kudu's extractor needs them: given a zip that
        # carries only file paths, it creates the top level and silently drops
        # the nested folders. The DLLs arrive, wwwroot does not, and the
        # deployment reports success -- so the relay answers and the game
        # 404s, with nothing anywhere saying why.
        #
        # Neither of the obvious tools writes those entries. Compress-Archive
        # omits them, and so does ZipFile::CreateFromDirectory, which only
        # emits an entry for a directory that is EMPTY. Both were tried
        # against this deployment and both failed the same way.
        $zip = Join-Path $repo "artifacts/rustipede.zip"
        if (Test-Path $zip) { Remove-Item $zip -Force }
        Add-Type -AssemblyName System.IO.Compression
        Add-Type -AssemblyName System.IO.Compression.FileSystem

        $root = (Resolve-Path $publish).Path.TrimEnd([System.IO.Path]::DirectorySeparatorChar)
        $stream = [System.IO.File]::Open($zip, [System.IO.FileMode]::Create)
        $archive = New-Object System.IO.Compression.ZipArchive(
            $stream, [System.IO.Compression.ZipArchiveMode]::Create)
        try {
            # Directories first, each with a trailing slash, as the format
            # expects and as the extractor looks for.
            Get-ChildItem -LiteralPath $publish -Recurse -Directory | ForEach-Object {
                $rel = $_.FullName.Substring($root.Length + 1).Replace("\", "/") + "/"
                [void] $archive.CreateEntry($rel)
            }
            Get-ChildItem -LiteralPath $publish -Recurse -File | ForEach-Object {
                $rel = $_.FullName.Substring($root.Length + 1).Replace("\", "/")
                [void] [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                    $archive, $_.FullName, $rel,
                    [System.IO.Compression.CompressionLevel]::Optimal)
            }
        }
        finally {
            $archive.Dispose()
            $stream.Dispose()
        }

        # Prove the structure before shipping it, rather than finding out from
        # a 404 on a site that deployed "successfully".
        $check = [System.IO.Compression.ZipFile]::OpenRead($zip)
        try {
            $dirs = @($check.Entries | Where-Object { $_.FullName.EndsWith("/") })
            $client = @($check.Entries | Where-Object { $_.FullName -like "wwwroot/*" -and -not $_.FullName.EndsWith("/") })
            if ($dirs.Count -eq 0) { throw "Packaging produced no directory entries; Kudu would drop wwwroot." }
            if ($client.Count -eq 0) { throw "Packaging produced no client files under wwwroot/." }
            Ok "packaged $([math]::Round((Get-Item $zip).Length / 1MB, 2)) MB ($($dirs.Count) dirs, $($client.Count) client files)"
        }
        finally { $check.Dispose() }

        Step "Deploying"
        if ($PSCmdlet.ShouldProcess($Name, "zip deploy")) {
            # Oryx would otherwise try to BUILD what we just published,
            # and fail: it expects sources, not a publish output.
            Invoke-Az webapp config appsettings set --name $Name --resource-group $ResourceGroup `
                --settings SCM_DO_BUILD_DURING_DEPLOYMENT=false --output none
            # --track-status false, and then check for ourselves.
            #
            # The CLI's own startup tracking calls a slow cold start a failed
            # one. It did exactly that here: it polled for 876 seconds and
            # reported "Site failed to start", while the container log for the
            # same deployment read "Site startup probe succeeded after 144.98
            # seconds" and then "Site started". The site was serving 200 the
            # whole time the CLI was declaring it dead.
            #
            # A false failure is worse than no check. It sends you looking for
            # a crash that never happened, and it fails the script -- which on
            # a pipeline would fail the build over a healthy deploy. So turn
            # the unreliable tracker off and ask the site itself, which is the
            # question that was being approximated anyway.
            Invoke-Az webapp deploy --name $Name --resource-group $ResourceGroup `
                --src-path $zip --type zip --restart true --track-status false --output none
            Ok "uploaded"

            Note "waiting for the site to answer (a cold start on a shared plan takes a while)"
            $url = "https://$Name.azurewebsites.net"
            $site = 0
            foreach ($attempt in 1..60) {
                try {
                    $site = [int] (Invoke-WebRequest -Uri "$url/" -UseBasicParsing -TimeoutSec 20).StatusCode
                }
                catch { $site = 0 }
                if ($site -eq 200) { break }
                Start-Sleep -Seconds 10
            }
            if ($site -ne 200) { throw "The site did not answer 200 within ten minutes (last was $site)." }
            Ok "site is up"

            # 200 proves the static half. The relay is the half that breaks
            # silently -- WebSockets are off by default, and when they are off
            # nothing appears in the log because the request never reaches the
            # app. A plain GET to the socket path must be REFUSED with 400.
            $relay = 0
            try { $relay = [int] (Invoke-WebRequest -Uri "$url/ws/mp" -UseBasicParsing -TimeoutSec 20).StatusCode }
            catch { $relay = [int] $_.Exception.Response.StatusCode }
            if ($relay -ne 400) {
                throw "The relay answered $relay at /ws/mp; 400 is expected -- it means the endpoint exists and refused a non-WebSocket request. 404 means the app is not routing it."
            }
            Ok "relay is up (400 at /ws/mp, which is the refusal that proves it)"
        }
    }
    finally { Pop-Location }
}

# --- Done ------------------------------------------------------------------
$url = "https://$Name.azurewebsites.net"
Step "Done"
Write-Host "    $url" -ForegroundColor Green
Note ""
Note "Open it in TWO windows to try co-op (two tabs pause each other)."
Note "Logs:    az webapp log tail --name $Name --resource-group $ResourceGroup"
Note "Redeploy: ./infra/provision.ps1 -Deploy"
# Teardown differs entirely depending on who owns the plan, and getting it
# wrong in either direction is bad: deleting a plan other apps live on, or
# believing billing stopped when it did not.
if ($adoptedPlan) {
    Note "Remove the game:   az webapp delete --name $Name --resource-group $ResourceGroup"
    Note "                   (leaves '$plan' and the $(@($neighbourNames).Count) other apps on it alone)"
}
else {
    Note "Delete everything: az group delete --name $ResourceGroup --yes"
    Note "                   (the app AND its plan, which is what stops the billing)"
}
