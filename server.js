const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const compression = require("compression");
const path = require("path");
require("dotenv").config();

const app = express();

// Trust Nginx reverse proxy so rate limiter sees real visitor IPs
app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
  }),
);
app.use(compression());

// UPDATED: Allow the new domain
app.use(
  cors({
    origin: [
      "http://quotes.nationallifecoverage.org",
      "https://quotes.nationallifecoverage.org",
    ],
  }),
);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
});
app.use(limiter);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname)));

// MongoDB Connection
mongoose
  .connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

const submissionRoutes = require("./routes/submissions");
const analyticsRoutes = require("./routes/analytics");
const authRoutes = require("./routes/auth");
const batchRoutes = require("./routes/batch");

app.use("/api/submissions", submissionRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/batch", batchRoutes);

app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard", "index.html"));
});

// Batch CSV test harness UI. The page itself is static; every action it takes
// goes through /api/batch, which sits behind the dashboard's JWT auth.
app.get("/dashboard/batch", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard", "batch.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "login-test.html"));
});

app.post("/api-proxy/", require("./middleware/formHandler"));

app.get("/depo", (req, res) => {
  res.sendFile(path.join(__dirname, "depo.html"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.use((error, req, res, next) => {
  console.error("Server Error:", error);
  res.status(500).json({
    message: "Internal server error",
    error: process.env.NODE_ENV === "development" ? error.message : {},
  });
});

app.use((req, res) => {
  res.status(404).json({ message: "Route not found" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
