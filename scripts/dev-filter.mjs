import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");

const blockedPatterns = [
  /^\[browser\] ⨯ unhandledRejection: TypeError: Cannot destructure property 'current' of 't' as it is undefined\.$/,
  /^\[browser\] ⨯ unhandledRejection: TypeError: Cannot read properties of undefined \(reading 'displayName'\)$/,
  /chrome-extension:\/\/cgibknllccemdnfhfpmjhffpjfeidjga\/bundles\/backend\.bundle\.js/,
];

const shouldBlock = (line) => blockedPatterns.some((pattern) => pattern.test(line));

const child = spawn(process.execPath, [nextBin, "dev"], {
  env: process.env,
  stdio: ["inherit", "pipe", "pipe"],
});

const pipeFiltered = (stream, target) => {
  let remainder = "";
  let suppressFollowingStack = false;

  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    const text = remainder + chunk;
    const lines = text.split("\n");
    remainder = lines.pop() ?? "";

    for (const line of lines) {
      if (suppressFollowingStack) {
        if (/^\s+at /.test(line)) {
          continue;
        }
        suppressFollowingStack = false;
      }

      if (shouldBlock(line)) {
        suppressFollowingStack = true;
        continue;
      }

      target.write(`${line}\n`);
    }
  });

  stream.on("end", () => {
    if (
      remainder &&
      !shouldBlock(remainder) &&
      !(suppressFollowingStack && /^\s+at /.test(remainder))
    ) {
      target.write(remainder);
    }
  });
};

pipeFiltered(child.stdout, process.stdout);
pipeFiltered(child.stderr, process.stderr);

child.on("close", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

