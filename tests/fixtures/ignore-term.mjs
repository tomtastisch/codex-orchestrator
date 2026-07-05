process.on("SIGTERM", () => {});
setInterval(() => process.stdout.write("alive\n"), 20);
