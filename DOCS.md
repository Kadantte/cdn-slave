# API Usage

CDN Slave exposes a minimal HTTP API for uploading files to Discord's CDN and retrieving them through a stable proxy URL.

## Base URL

Use your server base URL, for example:

- Local: `http://localhost:443`
- Hosted: `https://your-domain.example`

## Authentication

None. Access is controlled by your server settings, rate limits, and upload rules.

## Endpoints

### `GET /health`

Health check for the web server + database.

- `200` with JSON: `{"status":"ok"}`
- `503` with JSON: `{"status":"error"}`

### `POST /api/upload`

Upload a file or resolve an existing Discord message by ID.

#### Upload a file (recommended for API use)

Send a `multipart/form-data` request with a `file` field.

Headers:
- `Upload-Source: API` to return a direct CDN URL instead of redirecting.

Example (curl):

```bash
curl -X POST \
  -H "Upload-Source: API" \
  -F "file=@/path/to/file.png" \
  https://your-domain.example/api/upload
```

Response:
- `200` with plain text body of the Discord CDN URL (when `Upload-Source: API` is set).
- `302` redirect to `/results` (when the header is not set).

#### Resolve an existing message

Send `application/x-www-form-urlencoded` or `multipart/form-data` with a `mid` field.

Example (curl):

```bash
curl -X POST \
  -d "mid=123456789012345678" \
  https://your-domain.example/api/upload
```

Response:
- `302` redirect to `/results` if the message exists and has an attachment.
- `404` if the message is missing or has no attachments.

#### Error responses

- `400` No file was provided.
- `413` File too large.
- `415` Unsupported file type.
- `429` Too many requests (rate limit).
- `503` Too many concurrent uploads.
- `500` Internal server error.

### `GET /attachments/:messageId/:attachmentId/:filename`

Proxy an attachment through your server, with support for HTTP range requests.

Example:

```
GET /attachments/123456789012345678/987654321098765432/file.png
```

Behavior:
- Returns the file as an attachment with the requested filename.
- `404` if the message or attachment cannot be found.
- `500` on proxy errors.

## Upload limits and rules

Uploads are controlled by `Global.js`:

- `maxFileSize` controls maximum size (enforced server-side).
- `upload.rateLimit.windowMs` and `upload.rateLimit.max` limit requests per IP.
- `upload.maxConcurrent` caps simultaneous uploads.
- `upload.allowedMimeTypes` and `upload.allowedMimePrefixes` define MIME allowlists.
- `upload.tempDir` chooses where temp files are stored.

## Notes

- The API returns a Discord CDN URL when `Upload-Source: API` is set.
- The `/results` page uses cookies set by the server; it is intended for browser usage.
