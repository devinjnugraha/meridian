module.exports = {
  apps: [
    {
      name: "meridian-main",
      cwd: __dirname + "/..",
      script: "index.js",
      autorestart: true,
      env: { NODE_ENV: "production" },
    },
    {
      name: "meridian-companion",
      cwd: __dirname,
      script: "index.js",
      autorestart: true,
      env: { NODE_ENV: "production" },
    },
  ],
};
