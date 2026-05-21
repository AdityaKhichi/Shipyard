const express = require("express");
const httpProxy = require("http-proxy");

const app = express();
const port = process.env.REVERSE_PROXY_PORT || 80;
const bucketName = process.env.S3_BUCKET_NAME || "shipyard-bucket";
const bucketRegion = process.env.AWS_REGION || "ap-south-1";
const bucketUrl = `https://${bucketName}.s3.${bucketRegion}.amazonaws.com/builds`;
const proxy = httpProxy.createProxy();

app.use((req, res) => {
  const hostname = req.hostname;
  const subdomain = hostname.split(".")[0];
  const targetUrl = `${bucketUrl}/${subdomain}`;

  proxy.web(req, res, {
    target: targetUrl,
    changeOrigin: true,
  });
});

proxy.on("proxyReq", (proxyReq, req) => {
  if (req.url === "/") {
    proxyReq.path += "index.html";
  }
});

proxy.on("error", (err, req, res) => {
  console.error("Proxy error:", err);
  res.status(502).send("Bad Gateway: Could not connect to the upstream server.");
});

app.listen(port, () =>
  console.log(`Shipyard reverse proxy running on http://localhost:${port}`)
);
