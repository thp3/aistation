/** Only Vite's content-hashed public assets are safe to cache across releases. */
export function setStaticCacheHeaders(res,filePath){
  if(/[\\/]assets[\\/][^\\/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i.test(filePath))
    res.setHeader('Cache-Control','public, max-age=31536000, immutable');
}
