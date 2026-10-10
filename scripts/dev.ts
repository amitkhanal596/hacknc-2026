export {};
const children = [
  Bun.spawn(["bun", "--watch", "server/src/index.ts"], {
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  }),
  Bun.spawn(["bun", "--bun", "vite", "--host", "127.0.0.1"], {
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  }),
];
const closeChildren = () => {
  children.forEach((child) => child.kill());
  process.exit(0);
};
process.on("SIGINT", closeChildren);
process.on("SIGTERM", closeChildren);
await Promise.race(children.map((child) => child.exited));
closeChildren();
