# YouTube Vertical Clipper API

Servicio que descarga videos de YouTube, corta segmentos y aplica **smart crop** para formato vertical (9:16) listo para redes sociales.

## Deploy en Railway

1. Sube este repo a GitHub
2. Conecta el repo en [railway.app](https://railway.app)
3. Railway detectará el Dockerfile automáticamente
4. Configura las variables de entorno opcionales:
   - `API_KEY` — Clave para autenticar requests (opcional)
   - `PORT` — Puerto (por defecto 3000, Railway lo sobrescribe)

## API Endpoints

### `GET /health`
Health check.

### `POST /api/info`
Obtiene metadatos de un video sin descargarlo.

```json
{
  "url": "https://youtube.com/watch?v=VIDEO_ID"
}
```

### `POST /api/process`
Procesa un video: descarga, corta y convierte a vertical.

**Body:**
```json
{
  "url": "https://youtube.com/watch?v=VIDEO_ID",
  "startTime": "00:01:30",
  "endTime": "00:02:15",
  "mode": "smart",
  "crf": 23,
  "preset": "fast"
}
```

| Campo      | Tipo   | Requerido | Default | Descripción |
|-----------|--------|-----------|---------|-------------|
| `url`     | string | Si        | —       | URL del video de YouTube |
| `startTime` | string/number | Si | — | Inicio del clip (HH:MM:SS, MM:SS o segundos) |
| `endTime` | string/number | Si | — | Fin del clip |
| `mode`    | string | No | `smart` | `smart` = recorte inteligente, `center` = centro fijo, `dynamic` = paneo dinámico |
| `crf`     | number | No | 23 | Calidad del video (18=alta, 28=baja) |
| `preset`  | string | No | `fast` | Velocidad de encoding (`ultrafast`, `fast`, `medium`, `slow`) |

**Response:** Archivo `.mp4` (video/mp4) directamente en el body.

## Modos de Crop

### `smart` (recomendado)
Analiza frames del video para detectar la región con mayor actividad visual (el sujeto/hablante) y centra el crop ahí.

### `center`
Corta simplemente el centro del video. Rápido y funciona bien cuando el sujeto ya está centrado.

### `dynamic`
Crea un efecto de paneo suave que sigue al sujeto a lo largo del clip. Más lento pero más dinámico.

## Integración con n8n

En tu workflow de n8n, usa un nodo **HTTP Request**:

- **Method:** POST
- **URL:** `https://tu-service.railway.app/api/process`
- **Headers:**
  - `Content-Type`: `application/json`
  - `x-api-key`: `tu-api-key` (si configuraste una)
- **Body:** JSON con `url`, `startTime`, `endTime`
- **Response Format:** File (binary)

El nodo te devolverá el archivo `.mp4` listo para subir a redes sociales.

## Stack

- **Node.js** + Express
- **yt-dlp** — Descarga de YouTube
- **FFmpeg** — Corte, crop y encoding
- **Sharp** — Análisis de frames para smart crop
- **Docker** — Deploy en Railway