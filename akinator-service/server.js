/**
 * Always-on HTTP entry point for the Akinator relay.
 *
 * Used locally (`PORT=8080 npm start`), on Northflank (PORT is injected by the
 * platform) and on any other Node host / VM. Keep the process listening on
 * 0.0.0.0 so the platform's proxy can reach it.
 */

const { app } = require("./app");

const port = parseInt(process.env.PORT || "8080", 10);
const server = app.listen(port, "0.0.0.0", function () {
    console.log("Akinator relay listening on 0.0.0.0:" + port);
});

function shutdown() {
    server.close(function () {
        process.exit(0);
    });
    // Don't hang forever on a stuck keep-alive connection.
    setTimeout(function () {
        process.exit(0);
    }, 5000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
