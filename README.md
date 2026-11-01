# VIBELY — Scarlett Monroe AI Influencer Studio

Full-stack AI influencer video and original music generation platform built around a two-layer AI architecture:

1. **Layer 1 (Reasoning & Production Director)**: NVIDIA API (`nvidia/nemotron-3-ultra-550b-a55b` primary, `minimaxai/minimax-m3.1-flash` fallback) plans cohesive 20–40 second multi-scene storylines, weighted content series (`The Hip Movement Challenge` 35%, `The Bounce Dance` 30%, `The Bodycon Transition` 20%, `The Gym Challenge` 15%), anti-repetition similarity checks, camera/choreography transitions, and original Amapiano + Afrobeats Fusion song arrangements.
2. **Layer 2 (ComfyUI Media Generation)**:
   - **MiniMax Music 3 Q4_0 GGUF** (`ComfyUI + molbal/ComfyUI-GGUF` on Kaggle GPU `@happink`) generates full original Amapiano + Afrobeats Fusion tracks with female vocals, log drums, punchy bass, hooks, chorus, and drop.
   - **MiniMax H3 Ref2VA** (`ComfyUI + molbal/ComfyUI-GGUF` on Kaggle GPU `@Joshbond123`) generates ultra-photorealistic 9:16 multi-scene Scarlett Monroe videos conditioned on 3 persistent verified reference photographs (`assets/references/scarlett_ref_{1,2,3}.jpg`) and synced continuously to the master song timeline.

## Features
- **8-Section Responsive Studio UI**: Dashboard, Generate Video, Automations, Music Studio, Video Library, Character References, Generation History, and Settings.
- **Persistent Server-Side Scheduling**: Automated background scheduler (`node-cron` + PostgreSQL) executes scheduled generations independently of open browser sessions.
- **72-Hour Automatic Video Deletion**: Enabled by default (`ON`), toggleable `ON`/`OFF` in Settings; cleans expired MP4s and temporary artifacts while preserving AI models, Scarlett Monroe reference images, and core PostgreSQL history metadata.

## Development & Build
```bash
npm install
npm run build
npm start
```
