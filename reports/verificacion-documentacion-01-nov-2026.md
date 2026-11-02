# Video Factory — Informe de verificación (sin cambios de código)
## Visibilidad del repositorio/GHCR y desactualización de README.md/DEPLOY.md
**01 de noviembre de 2026**

Tarea de solo lectura: ningún archivo de infraestructura, visibilidad o configuración fue modificado. Lo que sigue es lo que se pudo comprobar contra el repo real y contra documentación oficial de GitHub, y lo que no se pudo verificar desde este entorno.

---

## 1. Visibilidad del repositorio — decisión de Alex no respetada hoy

`gh repo view aipowergrowth/video-factory --json visibility,isPrivate` devuelve:

```json
{"isPrivate": false, "visibility": "PUBLIC"}
```

Alex había decidido que el repositorio fuera **privado**. Hoy es **público**. No se cambió nada — es una decisión de Alex, no del auditor ni de Code.

### Efectos de pasarlo a privado (verificados contra documentación oficial de GitHub, salvo donde se indica lo contrario)

**GitHub Actions — sí tiene un efecto real de costo.** La cuenta `aipowergrowth` es una cuenta de **usuario personal**, no una organización (confirmado: `gh api /users/aipowergrowth` → `"type": "User"`). Documentación oficial de GitHub:

- *"Standard GitHub-hosted runners in public repositories"* son gratis sin límite, independientemente del plan.
- En repositorios **privados**, cada cuenta tiene un uso de cómputo incluido mensual expresado en dólares, no en minutos fijos — en el plan Free (personal) es **US$12/mes**, que equivale aproximadamente a 2.000 minutos en runners Linux estándar (el tipo que usan los 3 workflows de este repo: `docker-publish.yml`, `audio-regression-tests.yml`, `captions-destination-test.yml`, todos en `ubuntu-latest`). Minutos en Windows/macOS cuestan más por minuto — no aplica aquí.
- **No verificado:** qué plan de GitHub tiene exactamente la cuenta `aipowergrowth` hoy (Free, Pro, u otro) — la consulta a la API (`gh api /orgs/aipowergrowth`, `.../settings/billing/actions`) devolvió 404/permiso insuficiente desde este entorno. Si es Free, el límite de US$12/mes aplica tal cual. Confirmarlo en GitHub → Settings → Billing.
- Por defecto, las cuentas nuevas tienen un límite de gasto en US$0 para uso de Actions más allá del incluido — en la práctica, si se agota la cuota incluida, los workflows dejan de ejecutarse (no se cobra de más) salvo que Alex suba ese límite explícitamente. Esto es tranquilizador: pasar a privado no genera un cargo sorpresa, en el peor caso los workflows simplemente se detienen hasta el siguiente ciclo de facturación o hasta que Alex suba el límite.

**GitHub Container Registry (GHCR) — la visibilidad del paquete es independiente de la del repositorio**, confirmado en la documentación oficial de GitHub sobre paquetes: *"A package can inherit its visibility and access permissions from a repository, or... you can set the visibility and permissions of the package separately."* El paquete `ghcr.io/aipowergrowth/fabrica-videos-engine` ya fue configurado manualmente como público (paso explícito en `DEPLOY.md`, independiente de la visibilidad del repo) — pasar el repo a privado **no debería**, por este texto, volver privado automáticamente ese paquete.

**Matiz importante, no 100% despejado por la documentación:** la misma página oficial distingue visibilidad de **permisos de acceso**: *"the package automatically inherits the access permissions (but not the visibility) of the linked repository"*, salvo que se desactive la opción "Inherit access from repository" en la configuración del paquete. Es decir: aunque la etiqueta del paquete siga diciendo "Público", si esa opción de herencia está activada, los permisos reales de quién puede descargarlo podrían verse afectados por la nueva visibilidad privada del repo — la documentación no es inequívoca sobre si esto rompe el `docker pull` anónimo en la práctica. **No verificado de forma concluyente** — recomiendo que, si Alex decide pasar el repo a privado, confirme en GitHub → paquete `fabrica-videos-engine` → Package settings que "Inherit access from repository" está DESACTIVADO y que la visibilidad siga marcada como "Public" de forma independiente, y pruebe un `docker pull` sin credenciales inmediatamente después del cambio.

**Pull de imagen desde Portainer:** si el paquete se mantiene realmente público e independiente (punto anterior resuelto a favor), Portainer sigue descargando sin credenciales, sin cambios. Si el pull anónimo deja de funcionar, `DEPLOY.md` ya documenta la alternativa (crear un token con `read:packages` y configurar el registro con credenciales en Portainer) — son 3-4 clics más, ya escritos, no hay que inventar nada nuevo.

**Recomendación:** si Alex decide pasar a privado, hacerlo y probar el pull de imagen y una corrida de Actions ANTES de depender de ello en producción — no asumir que "la documentación dice que debería funcionar" sin una prueba real, mismo principio que el resto del proyecto.

## 2. GHCR: visibilidad del paquete en sí — no verificada

No se pudo confirmar la visibilidad actual del paquete (`gh api /orgs/aipowergrowth/packages/container/fabrica-videos-engine` → 404, y los endpoints de listado de paquetes también devolvieron 404) — probablemente una limitación de permisos de este token (no tiene alcance `read:packages`/`admin:org`), no evidencia de que el paquete no exista o no sea público. Confirmarlo manualmente en GitHub → `aipowergrowth` → Packages.

## 3. README.md y DEPLOY.md: tablas de endpoints desactualizadas

Las tablas de "Contrato de la API" de ambos documentos listan solo `POST /jobs`, `GET /jobs/:id`, `GET /jobs/:id/download`. El código real (`server/index.mjs`) expone, además: `GET /health`, `GET /jobs`, `POST /jobs/:id/finalize`, `POST /jobs/:id/replan`, `POST /jobs/:id/snap-cuts`, `POST /jobs/:id/cancel`. No se tocó ninguno de los dos documentos — queda a decisión de Alex si corregirlos.

## 4. DEPLOY.md: afirmación obsoleta sobre persistencia de jobs

`DEPLOY.md`, sección "Qué NO está resuelto todavía", dice: *"El estado de los jobs vive en memoria: si el contenedor se reinicia a mitad de un render, se pierde el registro de ese job puntual."* Esto ya no es cierto — confirmado leyendo `server/index.mjs`: el estado se persiste en disco (`<jobId>.status.json`) y se recupera al reiniciar (`recoverJobsFromDisk()`), marcando como `"error"` — con un mensaje claro para quien lo vea — los jobs que estaban en curso al momento del reinicio, no perdiendo su registro. No se tocó el documento.

Las otras dos afirmaciones de esa misma sección de `DEPLOY.md` ("no hay reintentos automáticos si un render muere a mitad" y "no hay autenticación en la API") se buscaron en el código y no se encontró nada que las contradiga — no es una auditoría exhaustiva línea por línea, pero no hay evidencia de que estén desactualizadas.
