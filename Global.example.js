exports.config = {
  port: 443,
  host: 'localhost',
  publicUrl: 'http://localhost:443',
  token: 'BOT TOKEN',
  fileChannel: 'ID OF CHANNEL TO SEND FILES',
  maxFileSize: {
    human: "100mb",
    byte: 104857600
  },
  logLevel: 'info',
  defaultTimezone: 'America/Los_Angeles',
  upload: {
    maxConcurrent: 3,
    rateLimit: {
      windowMs: 900000,
      max: 30
    },
    allowedMimeTypes: [
      'application/pdf',
      'application/zip'
    ],
    allowedMimePrefixes: [
      'image/',
      'video/',
      'audio/',
      'text/'
    ],
    tempDir: 'data/tmp'
  },
  database: {
    filename: 'data/cdn-slave.sqlite'
  }
}
