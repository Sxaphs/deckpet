# DeckPet — Mascotas de escritorio como front-end para CLIs de agentes

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | **Español**

Aplicación de mascotas de escritorio para Windows 10/11: sube una foto, el personaje se recorta y se redibuja como un sprite que gatea, y vive en tu pantalla—trepa por tus ventanas, se cuelga de los bordes—mientras charla contigo con globos de texto (solo texto, sin voz). Por dentro habla con backends de agente reales (Kimi Code CLI vía ACP, DeepSeek Harness o cualquier endpoint compatible con OpenAI), con una capa de permisos estricta que controla cada escritura de archivo y cada comando.

## Características

- **Foto → mascota**: recorte con rembg + redibujado de poses con IA (Seedream i2i de Volcengine o cualquier API de imágenes compatible con OpenAI), generando un set completo de 15 acciones (gatear, trepar, colgarse, rodar, descansar, 3 formas de boca, saludar, saltar, sentarse triste, pensar, asustarse, caerse y levantarse). ¿Sin API de imágenes? Los sprites predefinidos funcionan de inmediato.
- **Runtime de escritorio**: ventana transparente a pantalla completa, siempre encima; los píxeles vacíos dejan pasar el clic, el cuerpo de la mascota es arrastrable (con inercia, se tropieza y se levanta). Enumeración Win32 en tiempo real: las mascotas gatean por el borde superior de las ventanas, trepan por los lados y se cuelgan del borde superior de la pantalla como una barra fija.
- **Chat estilo kimi web**: clic = frase predefinida; doble clic = globo de chat con respuestas en streaming, animación de boca, respuestas largas plegadas en resumen con panel de lectura "expandir todo" (Markdown + resaltado de código). Botón DEV para ver las llamadas de herramientas; el proceso completo se registra en una página web local.
- **Arquitectura multiagente (4 capas estrictas)**: presentación (renderer) → orquestador (enrutado, modo colaboración: dividir → informar → resumir) → adaptadores (drivers por plugin: ACP / dsh / openai-http) → capa de permisos (única puerta para escritura de archivos, shell y red).
- **Permisos**: solo lectura / preguntar / automático por personaje; lista blanca de directorios, lista negra de comandos, interruptor de red, excepciones de intranet. Los secretos se guardan con DPAPI de Windows, nunca en texto plano.
- **Consola web** (`http://127.0.0.1:17890`): subir fotos, configurar claves, ajustar prompts de apariencia, archivar, cambiar y eliminar versiones de sprites, gestionar recordatorios.

## Inicio rápido (exe portable)

1. Descarga `DeckPet-<versión>-portable.exe` desde Releases y ejecútalo.
2. Primer arranque: la mascota integrada **Nailong (奶龙)** aparece directamente en tu escritorio (sin configuración) y se abre automáticamente la **página de Ajustes**:
   - Añade un backend — lo más fácil es `kimi acp` si tienes Kimi Code CLI instalado (tipo `acp`, comando `kimi`, args `acp`), o cualquier endpoint compatible con OpenAI con su API key.
   - (Opcional) pega una clave de API de imágenes para sprites con poses de IA.
   - Sube una foto → sustituye a Nailong por una mascota hecha con tu propia foto.
3. Interacción: **clic** = frase, **doble clic** = chat, **arrastrar** = levantarla (se asusta), soltar en el borde superior = colgarse de la barra, clic derecho = menú. Icono en la bandeja: ocultar/mostrar, ajustes, consola web, salir.

Requisitos: Windows 10/11 x64. Para el backend ACP necesitas el CLI del agente instalado y con sesión iniciada. Los sprites de IA requieren una clave de API de edición de imágenes (se recomienda Volcengine Ark; ~500 llamadas gratis).

## Desarrollo

Requiere Node.js ≥ 20 y Python ≥ 3.10 (Python es opcional: solo para el recorte con rembg y el postprocesado de sprites de IA).

```bash
npm install
npm run build
npm start        # lanzar la mascota
npm test         # vitest: permisos, plegado, emoción, orquestador
npm run pack     # electron-builder → exe portable en release/
```

Validación por CLI del núcleo de agentes (sin GUI):

```bash
npm run build:core
node dist/core/cli/index.js backends add --type acp --name Kimi --command kimi --args "acp"
node dist/core/cli/index.js chars add --id char-1 --name Amigo --line-a "¡Hola!"
node dist/core/cli/index.js chat --char char-1 "Preséntate en una frase"
node dist/core/cli/index.js collab --chars char-1,char-2 --task "Piensa un eslogan"
```

## Arquitectura

```
src/renderer/   Presentación (solo DOM/TS, habla vía window.deckpet IPC)
src/main/       Proceso principal de Electron: ventanas / IPC / Win32 / bandeja / consola web
src/core/orchestrator/  Enrutado, sesiones, colaboración multiagente
src/core/adapters/      Registro de drivers por plugin (acp / dsh / openai-http)
src/core/permission/    Motor de políticas — toda acción peligrosa pasa por authorize()
pipeline/               Pipeline de sprites (cutout.py / placeholder_gen.py /
                        frame_post.py / gen_frames.ts)
```

Los contratos entre capas están en `src/core/types.ts`, `src/core/ipc-contract.ts` y `src/core/sprite-contract.ts`. Para añadir un backend nuevo consulta [docs/adapter-api.md](docs/adapter-api.md), detalles de ejecución en [docs/run.md](docs/run.md) y empaquetado en [docs/packaging.md](docs/packaging.md).

## Ubicación de datos

- Ajustes e historial: `%USERPROFILE%/.deckpet/` (se puede cambiar con `DECKPET_HOME`)
- Secretos: `%USERPROFILE%/.deckpet/keys/` (cifrado DPAPI)
- Sprites: exe empaquetado en `%APPDATA%/deckpet/assets/sprites/`; en desarrollo `assets/sprites/`

## Notas

- DeepSeek Harness está en developer preview y no ha pasado una auditoría de seguridad completa; sus plugins de aprobación nunca son la única defensa: la capa de permisos de DeckPet siempre tiene la última palabra.
- Generar sprites con IA consume llamadas de API (15 por set completo). Los sprites se archivan antes de cada regeneración y se pueden restaurar o cambiar en cualquier momento desde la consola web.

## Licencia

MIT
