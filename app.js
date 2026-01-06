/* modules */
const { Client, GatewayIntentBits } = require("discord.js");
const fs = require("fs");
const os = require("os");
const path = require("path");
const pino = require("pino");
const pinoHttp = require("pino-http");
const cookieParser = require("cookie-parser");
const fileUpload = require("express-fileupload");
const mimeTypes = require("mime-types");
const express = require("express");
const axios = require("axios");

const { ensureDatabaseDirectory, getKnexConfig } = require("./db.js");

/* global variables */
const Global = require("./Global.js").config;
const app = express();
const logger = pino({ level: Global.logLevel || "info" });
const httpLogger = pinoHttp({ logger });
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const maxFileSizeBytes =
  typeof Global.maxFileSize === "object"
    ? Number(Global.maxFileSize.byte)
    : Number(Global.maxFileSize);
const hasMaxFileSize =
  Number.isFinite(maxFileSizeBytes) && maxFileSizeBytes > 0;
const maxFileSizeHuman =
  typeof Global.maxFileSize === "object" && Global.maxFileSize.human
    ? Global.maxFileSize.human
    : hasMaxFileSize
    ? `${Math.round(maxFileSizeBytes / (1024 * 1024))}mb`
    : "";
const uploadDefaults = {
  maxConcurrent: 3,
  rateLimitWindowMs: 15 * 60 * 1000,
  rateLimitMax: 30,
  tempDir: path.join(__dirname, "data", "tmp"),
};
const maxConcurrentUploads = normalizePositiveInt(
  Global.upload?.maxConcurrent,
  uploadDefaults.maxConcurrent
);
const rateLimitWindowMs = normalizePositiveInt(
  Global.upload?.rateLimit?.windowMs,
  uploadDefaults.rateLimitWindowMs
);
const rateLimitMax = normalizeNonNegativeInt(
  Global.upload?.rateLimit?.max,
  uploadDefaults.rateLimitMax
);
const uploadTempDir = Global.upload?.tempDir || uploadDefaults.tempDir;
const allowedMimeTypes = (Array.isArray(Global.upload?.allowedMimeTypes)
  ? Global.upload.allowedMimeTypes
  : []
).map((value) => String(value).toLowerCase());
const allowedMimePrefixes = (Array.isArray(Global.upload?.allowedMimePrefixes)
  ? Global.upload.allowedMimePrefixes
  : []
).map((value) => String(value).toLowerCase());
const resolvedUploadTempDir = ensureUploadTempDir(uploadTempDir);

let knex = null;
let cachedFileChannel = null;
let activeUploads = 0;
const uploadRateLimiter = createRateLimiter({
  windowMs: rateLimitWindowMs,
  max: rateLimitMax,
});

/* discord client */
client.on("ready", () => {
  logger.info({ user: client.user.tag }, "Discord client ready.");
});

/* middleware */
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(httpLogger);
app.use(cookieParser());
app.use(
  fileUpload({
    useTempFiles: true,
    tempFileDir: resolvedUploadTempDir,
    createParentPath: true,
    safeFileNames: true,
    preserveExtension: true,
    limits: hasMaxFileSize ? { fileSize: maxFileSizeBytes } : undefined,
    abortOnLimit: true,
  })
);

/* static files */
app.use(express.static("public"));

/* set views */
app.set("views", `${__dirname}/views`);
app.set("view engine", "ejs");

/* routes */
app.get("/health", async (req, res) => {
  try {
    await knex.raw("select 1");
    res.status(200).json({ status: "ok" });
  } catch (error) {
    logger.error({ err: error }, "Health check failed.");
    res.status(503).json({ status: "error" });
  }
});

app.get("/", (req, res) => {
  res.render("index", {
    humanFileSize: maxFileSizeHuman,
    byteFileSize: maxFileSizeBytes,
  });
});

app.get("/results", (req, res) => {
  const uploadResults = req.cookies.results;
  if (!uploadResults) {
    return res.redirect("/");
  }

  const fileType = normalizeMimeType(uploadResults.mime || "");
  const fileTypeSlug = fileType.includes("/") ? fileType.split("/")[1] : "";

  res.render("results", {
    url: uploadResults.cdn,
    proxyURL: uploadResults.proxy,
    customURL: uploadResults.custom,
    messageId: uploadResults.id,
    uploadDate: uploadResults.uploaded,
    uploadedAt: uploadResults.uploadedAt,
    fileType,
    fileTypeSlug,
  });
});

app.get("/attachments/:messageId/:attachmentId/:filename", async (req, res) => {
  const { messageId, attachmentId, filename } = req.params;

  try {
    const row = await knex("message_ids").where("ahid", attachmentId).first();
    const resolvedMessageId = row?.mid || messageId;

    if (!resolvedMessageId) {
      return res
        .status(404)
        .send("Message ID not found for the given attachment.");
    }

    const channel = await getFileChannel();
    let message;
    try {
      message = await channel.messages.fetch(resolvedMessageId.toString());
    } catch (error) {
      return res.status(404).send("Message not found.");
    }
    const attachment =
      message.attachments.get(attachmentId) || message.attachments.first();

    if (!attachment) {
      return res.status(404).send("CDN URL not found for the given message.");
    }

    const safeFilename = sanitizeFilename(
      filename,
      attachment.name || "file"
    );
    const range = req.headers.range;
    const response = await axios.get(attachment.url, {
      responseType: "stream",
      headers: range ? { Range: range } : undefined,
    });

    res.status(response.status);
    res.setHeader(
      "Content-Type",
      response.headers["content-type"] || "application/octet-stream"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeFilename}"`
    );
    if (response.headers["content-length"]) {
      res.setHeader("Content-Length", response.headers["content-length"]);
    }
    if (response.headers["content-range"]) {
      res.setHeader("Content-Range", response.headers["content-range"]);
    }
    if (response.headers["accept-ranges"]) {
      res.setHeader("Accept-Ranges", response.headers["accept-ranges"]);
    }

    response.data.pipe(res);
  } catch (error) {
    logger.error({ err: error }, "Error streaming file from CDN.");
    res.status(500).send("Internal Server Error");
  }
});

app.post("/api/upload", uploadRateLimiter, async (req, res) => {
  try {
    const messageId = req.body?.mid?.toString().trim();
    if (messageId) {
      try {
        const channel = await getFileChannel();
        const message = await channel.messages.fetch(messageId);
        if (!message.attachments.first()) {
          return res.status(404).send("Message has no attachments.");
        }
        setCookies(req, res, message);
        return res.redirect("/results");
      } catch (error) {
        return res.status(404).send("Message not found.");
      }
    }

    const fileEntry = req.files?.file;
    const file = Array.isArray(fileEntry) ? fileEntry[0] : fileEntry;
    if (!file) {
      return res.status(400).send("No file was provided.");
    }

    if (hasMaxFileSize && file.size > maxFileSizeBytes) {
      return res.status(413).send("File too large.");
    }

    if (maxConcurrentUploads > 0 && activeUploads >= maxConcurrentUploads) {
      res.setHeader("Retry-After", "1");
      return res.status(503).send("Too many concurrent uploads.");
    }

    const resolvedMime = resolveMimeType(file);
    if (!isMimeAllowed(resolvedMime)) {
      return res.status(415).send("Unsupported file type.");
    }

    activeUploads += 1;
    const tempFilePath = file.tempFilePath || "";
    const safeName = sanitizeFilename(file.name, "upload");

    try {
      const channel = await getFileChannel();
      const attachment =
        tempFilePath !== ""
          ? { attachment: tempFilePath, name: safeName }
          : { attachment: file.data, name: safeName };
      const message = await channel.send({ files: [attachment] });
      const uploaded = message.attachments.first();

      if (!uploaded) {
        return res.status(500).send("Upload failed.");
      }

      await knex("message_ids")
        .insert({ ahid: uploaded.id, mid: message.id })
        .onConflict("ahid")
        .merge({ mid: message.id });

      if (req.headers["upload-source"] === "API") {
        return res.send(uploaded.url);
      }

      setCookies(req, res, message);
      return res.redirect("/results");
    } finally {
      activeUploads = Math.max(activeUploads - 1, 0);
      if (tempFilePath) {
        try {
          await fs.promises.unlink(tempFilePath);
        } catch (error) {
          logger.warn({ err: error }, "Failed to remove temp upload file.");
        }
      }
    }
  } catch (error) {
    logger.error({ err: error }, "Upload failed.");
    res.status(500).send("Internal Server Error");
  }
});

async function getFileChannel() {
  if (cachedFileChannel) {
    return cachedFileChannel;
  }

  const channel = await client.channels.fetch(Global.fileChannel);
  if (!channel || !channel.isTextBased()) {
    throw new Error("Configured file channel is not a text channel.");
  }

  cachedFileChannel = channel;
  return cachedFileChannel;
}

async function initDatabase() {
  await knex.raw("PRAGMA journal_mode = WAL");
  await knex.raw("PRAGMA busy_timeout = 5000");
  const hasTable = await knex.schema.hasTable("message_ids");
  if (!hasTable) {
    await knex.schema.createTable("message_ids", (table) => {
      table.text("ahid").primary();
      table.text("mid").notNullable().index();
    });
  }
}

function getPublicBaseUrl(req) {
  if (Global.publicUrl) {
    return Global.publicUrl.replace(/\/$/, "");
  }
  return `${req.protocol}://${req.get("host")}`;
}

function buildCustomUrl(cdnUrl, baseUrl) {
  const cleanCdnUrl = cdnUrl.split("?")[0];
  const base = new URL(baseUrl);
  const target = new URL(cleanCdnUrl);
  target.protocol = base.protocol;
  target.host = base.host;
  return target.toString();
}

function setCookies(req, res, message) {
  const attachment = message.attachments.first();
  if (!attachment) {
    throw new Error("No attachment found on the message.");
  }

  const mimeFromAttachment =
    typeof attachment.contentType === "string" ? attachment.contentType : "";
  const requestFile = Array.isArray(req.files?.file)
    ? req.files.file[0]
    : req.files?.file;
  const nameForLookup = attachment.name || requestFile?.name || "";
  const mimeFromName = mimeTypes.lookup(nameForLookup) || "";
  const resolvedMime = normalizeMimeType(
    mimeFromAttachment || mimeFromName || requestFile?.mimetype || ""
  );
  const uploadTimestamp =
    Number(message.createdTimestamp) || Number(Date.now());
  const uploadDate = formatUploadDate(uploadTimestamp);

  res.cookie(
    "results",
    {
      cdn: attachment.url,
      proxy: attachment.proxyURL,
      custom: buildCustomUrl(attachment.url, getPublicBaseUrl(req)),
      id: message.id,
      uploadedAt: uploadTimestamp,
      uploaded: uploadDate,
      mime: resolvedMime,
    },
    { sameSite: "lax" }
  );
}

function normalizeMimeType(value) {
  if (!value) {
    return "";
  }
  return String(value).split(";")[0].trim().toLowerCase();
}

function resolveMimeType(file) {
  if (!file) {
    return "";
  }
  const fromMime = normalizeMimeType(file.mimetype || "");
  const lookupName = file.name || file.tempFilePath || "";
  const lookupMime = lookupName ? mimeTypes.lookup(lookupName) : "";
  const fromLookup = normalizeMimeType(lookupMime || "");
  return fromMime || fromLookup;
}

function isMimeAllowed(mimeType) {
  const hasAllowlist =
    allowedMimeTypes.length > 0 || allowedMimePrefixes.length > 0;
  if (!hasAllowlist) {
    return true;
  }
  if (!mimeType) {
    return false;
  }
  if (allowedMimeTypes.includes(mimeType)) {
    return true;
  }
  return allowedMimePrefixes.some((prefix) => mimeType.startsWith(prefix));
}

function sanitizeFilename(value, fallback) {
  const base = path.basename(String(value || ""));
  const withoutControls = base.replace(/[\r\n]/g, "");
  const cleaned = withoutControls
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  const trimmed = cleaned.slice(0, 200);
  return trimmed || fallback;
}

function formatUploadDate(timestamp) {
  if (!Number.isFinite(timestamp)) {
    return "";
  }
  if (typeof Intl === "undefined" || typeof Intl.DateTimeFormat !== "function") {
    return `File uploaded on ${new Date(timestamp).toISOString()}`;
  }
  const timezone = Global.defaultTimezone || "America/Los_Angeles";
  const timeZoneOption =
    typeof timezone === "string" && timezone.trim() ? timezone.trim() : "";
  const baseOptions = {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  };
  const date = new Date(timestamp);

  const tryFormat = (options) =>
    `File uploaded on ${new Intl.DateTimeFormat(undefined, options).format(date)}`;

  try {
    const options = { ...baseOptions, timeZoneName: "short" };
    if (timeZoneOption) {
      options.timeZone = timeZoneOption;
    }
    return tryFormat(options);
  } catch (error) {
    try {
      const options = { ...baseOptions };
      if (timeZoneOption) {
        options.timeZone = timeZoneOption;
      }
      return tryFormat(options);
    } catch (fallbackError) {
      try {
        return tryFormat(baseOptions);
      } catch (finalError) {
        return `File uploaded on ${date.toISOString()}`;
      }
    }
  }
}

function ensureUploadTempDir(tempDir) {
  if (!tempDir) {
    return path.join(os.tmpdir(), "cdn-slave");
  }
  const resolved = path.isAbsolute(tempDir)
    ? tempDir
    : path.join(__dirname, tempDir);
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function normalizePositiveInt(value, fallback) {
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) {
    return Math.floor(num);
  }
  return fallback;
}

function normalizeNonNegativeInt(value, fallback) {
  const num = Number(value);
  if (Number.isFinite(num) && num >= 0) {
    return Math.floor(num);
  }
  return fallback;
}

function createRateLimiter({ windowMs, max }) {
  if (!windowMs || !max || max <= 0) {
    return (req, res, next) => next();
  }
  const bucket = new Map();
  return (req, res, next) => {
    const key = req.ip || req.connection?.remoteAddress || "unknown";
    const now = Date.now();
    const entry = bucket.get(key);
    if (!entry || entry.resetAt <= now) {
      bucket.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (entry.count >= max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).send("Too many requests. Try again later.");
    }

    entry.count += 1;
    return next();
  };
}

app.use((err, req, res, next) => {
  if (!err) {
    return next();
  }
  logger.error({ err }, "Unhandled request error.");
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).send("File too large.");
  }
  return res.status(500).send("Internal Server Error");
});

async function start() {
  try {
    ensureDatabaseDirectory(Global);
    knex = require("knex")(getKnexConfig(Global));
    await initDatabase();
    await client.login(Global.token);

    app.listen(Global.port, Global.host, () => {
      logger.info(
        { host: Global.host, port: Global.port },
        "Server is running."
      );
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to start server.");
    process.exit(1);
  }
}

start();
