// The co-op server: static files, and one socket handed to the relay.
//
// The relay holds no game state and never simulates anything — both players
// run the same deterministic simulation and nothing but inputs crosses the
// wire — which is why these few lines are the entire server, whatever the
// game is.

using Microsoft.Extensions.FileProviders;
using CCLLC.Coop;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.UseWebSockets();

app.Map("/ws/mp", async ctx =>
{
    if (!ctx.WebSockets.IsWebSocketRequest) { ctx.Response.StatusCode = 400; return; }
    using var socket = await ctx.WebSockets.AcceptWebSocketAsync();
    await Relay.Run(socket);
});

// A trailing slash is not cosmetic under a virtual directory; see GameBase's
// docs/TROUBLESHOOTING.md. Harmless at a site root, so it is always here.
app.Use(async (ctx, next) =>
{
    if (ctx.Request.Path == "" && ctx.Request.PathBase.HasValue)
    {
        ctx.Response.Redirect($"{ctx.Request.PathBase}/{ctx.Request.QueryString}", permanent: false);
        return;
    }
    await next();
});

// Serve the Vite build output directly — no copy step.
var webRoot = Path.Combine(app.Environment.ContentRootPath, "..", "dist");
var files = new PhysicalFileProvider(Path.GetFullPath(webRoot));
app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = files });
app.UseStaticFiles(new StaticFileOptions { FileProvider = files });

// Only when --urls was not supplied: passing it to app.Run() unconditionally
// would override --urls, silently ignoring the port a caller asked for —
// scripts/check.mjs starts this on its own port.
if (string.IsNullOrEmpty(builder.Configuration["urls"]))
{
    app.Urls.Add("http://localhost:5190");
}

app.Lifetime.ApplicationStarted.Register(() =>
    Console.WriteLine($"Rustipede: {string.Join(", ", app.Urls)}  (open two windows for co-op)"));

app.Run();
