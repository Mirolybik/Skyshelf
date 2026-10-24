# Тестирование и QA — SkyShelf Final 1.0 (Node.js / Fastify Backend)

Дата актуального прогона: **24 октября 2026 года**.
Backend полностью переведён со старой Java-версии на стек **Node.js 20+ / Fastify 4 / PostgreSQL 16 / MinIO (S3) / Argon2id / AES-256-GCM**.

## 1. Запуск автоматических и Smoke-тестов

В папке `backend/` используются встроенный тест-раннер Node.js (`node --test`) и HTTP-инъекция Fastify:

```bash
cd backend
npm test
