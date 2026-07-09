#!/usr/bin/env node
const args = process.argv.slice(2);
const joined = args.join(" ");

if (joined.includes("missing-host") && args.includes("test")) process.exit(1);
if (joined.includes("mkdir-fail-host") && args.includes("test")) process.exit(1);
if (joined.includes("mkdir-fail-host") && args.includes("mkdir")) process.exit(1);
if (joined.includes("copy-fail-host") && args.includes("test")) process.exit(1);
if (joined.includes("copy-fail-host") && joined.includes(":") && !args.includes("mkdir")) process.exit(1);
if (joined.includes("activate-fail-host") && args.includes("test")) process.exit(1);
if (joined.includes("activate-fail-host") && args.includes("chmod")) process.exit(1);
process.exit(0);
