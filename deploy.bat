@echo off
setlocal enabledelayedexpansion

REM SkyShelf — развёртывание тестового стенда одним скриптом (docker compose).
REM Использование:
REM   deploy.bat              — собрать и запустить стенд с демо-данными
REM   deploy.bat --no-seed    — без заполнения демо-данными
REM   deploy.bat --minio      — дополнительно поднять MinIO (APP_STORAGE=minio)
REM   deploy.bat down         — остановить стенд (данные в volumes останутся)
REM   deploy.bat logs         — смотреть логи
REM   deploy.bat status       — состояние контейнеров

cd /d "%~dp0"

set COMPOSE=docker compose
set SEED=true
set PROFILES=
set BUILD_FAILED=false

REM Проверка наличия Docker
where docker >nul 2>&1
if errorlevel 1 (
    echo Ошибка: Docker не установлен. См. https://docs.docker.com/engine/install/
    exit /b 1
)

REM Проверка плагина docker compose
%COMPOSE% version >nul 2>&1
if errorlevel 1 (
    echo Ошибка: не найден плагин docker compose.
    exit /b 1
)

REM Обработка команд down, logs, status
if "%~1"=="down" (
    %COMPOSE% --profile seed --profile minio down
    exit /b %errorlevel%
)
if "%~1"=="logs" (
    %COMPOSE% logs -f
    exit /b %errorlevel%
)
if "%~1"=="status" (
    %COMPOSE% ps
    exit /b %errorlevel%
)
if "%~1"=="ps" (
    %COMPOSE% ps
    exit /b %errorlevel%
)

REM Парсинг аргументов
:parse_args
if "%~1"=="" goto :args_done
if "%~1"=="--no-seed" set SEED=false
if "%~1"=="--minio" (
    set PROFILES=%PROFILES% --profile minio
    set APP_STORAGE=minio
)
shift
goto :parse_args
:args_done

echo >>> Сборка образов...

REM Если backend работает, останавливаем проект для пересборки
%COMPOSE% ps -q backend 2>nul | findstr /r "." >nul
if not errorlevel 1 (
    echo >>> Перезапуск стенда (backend будет поднят заново с актуальным кодом)...
    %COMPOSE% down --remove-orphans >nul 2>&1
)

REM Очистка кэша BuildKit
docker builder prune -f >nul 2>&1

REM Сборка backend
%COMPOSE% %PROFILES% build --no-cache backend
if errorlevel 1 (
    echo Предупреждение: сборка backend не удалась — стенд использует исходники с хоста (bind-mount), это не критично.
)

REM Сборка frontend
%COMPOSE% %PROFILES% build frontend
if errorlevel 1 set BUILD_FAILED=true

REM Проверка наличия необходимых файлов
for %%f in (src\server.js src\db\migrate-cli.js src\services\auth-service.js) do (
    if not exist "backend\%%f" (
        echo Ошибка: отсутствует backend\%%f — репозиторий неполный (git pull / git status).
        exit /b 1
    )
)

REM Проверка на старый код auth.register()
findstr /R "auth\.register(" backend\src\server.js >nul 2>&1
if not errorlevel 1 (
    echo Ошибка: в backend\src\server.js всё ещё вызывается auth.register() при старте.
    echo Рабочее дерево неактуально: выполните git pull (или git checkout -- backend\src\server.js).
    exit /b 1
)

echo >>> Миграции базы данных...

REM Запуск PostgreSQL
%COMPOSE% up -d db

REM Ожидание готовности PostgreSQL
for /L %%i in (1,1,30) do (
    %COMPOSE% exec -T db pg_isready -U skyshelf -d skyshelf >nul 2>&1
    if not errorlevel 1 goto :db_ready
    timeout /t 2 /nobreak >nul
)
:db_ready

REM Установка зависимостей если нужно
if not exist backend\node_modules\pg (
    echo >>> Установка зависимостей backend (локально, для миграций)...
    cd backend
    call npm ci --omit=dev
    cd ..
)

REM Выполнение миграций
set DB_USER=%DB_USER:skyshelf%
set DB_PASSWORD=%DB_PASSWORD:skyshelf%
set DB_NAME=%DB_NAME:skyshelf%
if "%DATABASE_URL%"=="" (
    set DATABASE_URL=postgres://%DB_USER%:%DB_PASSWORD%@db:5432/%DB_NAME%
)

echo >>> Применение миграций...
docker run --rm ^
    --network skyshelf_default ^
    -v "%CD%\backend\src:/app/src:ro" ^
    -v "%CD%\backend\node_modules:/app/node_modules:ro" ^
    -e DATABASE_URL=%DATABASE_URL% ^
    -w /app ^
    --entrypoint node ^
    node:20-alpine src/db/migrate-cli.js up

echo >>> Поднимаем стенд...

REM Функция проверки монтированного кода
call :verify_mounted_code
if !errorlevel! equ 0 (
    echo >>> Внутри монтирования лежит СТАРЫЙ server.js (виден auth.register) — пересоздаём контейнеры...
    docker rm -f skyshelf-mntcheck >nul 2>&1
    %COMPOSE% down --remove-orphans >nul 2>&1
)

REM Запуск сервисов
%COMPOSE% %PROFILES% up -d --force-recreate backend frontend
if errorlevel 1 (
    echo Ошибка: контейнеры не поднялись. Последние логи backend:
    %COMPOSE% logs --tail=50 backend
    exit /b 1
)

REM Финальная проверка кода
call :verify_mounted_code
if !errorlevel! equ 0 (
    echo Ошибка: даже после пересоздания контейнера в /app/src лежит старый server.js.
    echo Это означает, что бинд ./backend/src указывает не на ваше рабочее дерево
    echo ^(или скрипт запускается из другой копии репозитория^). Диагностика:
    echo   cd  # должны быть в корне этого репозитория
    echo   dir backend\src\server.js ^&^& findstr /N "auth.register(" backend\src\server.js   # на хосте совпадений быть не должно
    echo   docker inspect ^<container_id^> --format "{{json .Mounts}}"
    echo   # в выводе Mounts Source должен путь == pwd/backend/src
    exit /b 1
)

REM Проверка готовности
set PORT=%STAND_PORT:8088%
call :check_health
if !errorlevel! equ 0 (
    echo >>> Backend уже отвечает — пропускаем ожидание.
) else (
    echo >>> Ожидаем готовности backend...
    set ready=false
    for /L %%i in (1,1,15) do (
        call :check_health
        if !errorlevel! equ 0 (
            set ready=true
            goto :health_ok
        )
        echo ...попытка %%i/15
        timeout /t 2 /nobreak >nul
    )
    :health_ok

    if "!ready!"=="false" (
        echo Диагностика состояния контейнеров:
        %COMPOSE% ps

        for /f "delims=" %%a in ('%COMPOSE% ps -q backend 2^>nul') do set backend_cid=%%a

        if "!backend_cid!"=="" (
            echo Контейнер backend не найден (не создан или упал).
        ) else (
            for /f "delims=" %%a in ('docker inspect -f "{{.State.Running}}" !backend_cid! 2^>nul') do set running=%%a
            if "!running!"=="true" (
                echo Процесс backend запущен, но /api/health недоступен.
                echo    внутри контейнера:
                docker exec !backend_cid! node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>console.log('OK',r.status)).catch(e=>console.log('FAIL',e.message))"
                echo    снаружи (nginx):
                curl -s -o nul -w "%%{http_code}" --max-time 3 "http://localhost:!PORT!/api/health" 2>&1 || echo нет соединения
            ) else (
                echo Процесс backend НЕ запущен — смотрите логи ниже.
            )
        )

        echo Последние логи backend:
        %COMPOSE% logs --tail=50 backend
        exit /b 1
    )
)

REM Сидинг демо-данных
if "%SEED%"=="true" (
    echo >>> Демо-данные...
    %COMPOSE% --profile seed %PROFILES% run --rm seed
) else (
    echo >>> Без сидинга (--no-seed): аккаунтов в базе нет — зарегистрируйте их через форму или запустите deploy.bat без --no-seed.
)

echo.
echo ✔ Тестовый стенд SkyShelf запущен:
echo Frontend:  http://localhost:%PORT%
echo API:       http://localhost:%PORT%/api/health (nginx проксирует /api на backend)
echo.
echo Демо-вход (после deploy.bat с сидингом):
echo demo@skyshelf.local / SkyShelfDemo2026!   (OWNER)
echo anna@skyshelf.local / SkyShelfDemo2026!   (MEMBER)
echo ilya@skyshelf.local / SkyShelfDemo2026!   (READER)
echo.
echo Остановить: deploy.bat down     Логи: deploy.bat logs

exit /b 0

:verify_mounted_code
    REM Проверяем наличие старого кода в контейнере
    for /f "delims=" %%a in ('%COMPOSE% ps -q backend 2^>nul') do set cid=%%a

    if not "!cid!"=="" (
        docker exec !cid! test -f /app/src/server.js >nul 2>&1
        if not errorlevel 1 (
            for /f "delims=" %%a in ('docker exec !cid! findstr /R /C:"auth\.register(" /app/src/server.js 2^>nul ^| find /c /v ""') do set count=%%a
            if "!count!"=="ERR" exit /b 2
            if not "!count!"=="0" exit /b 1
            exit /b 0
        )
    )

    REM Если контейнер не работает, создаём временный
    for /f "delims=" %%a in ('%COMPOSE% run -d --name skyshelf-mntcheck --no-deps --entrypoint sh backend -c "sleep 60" 2^>nul') do set tmp=%%a
    if "!tmp!"=="" (
        echo Ошибка: не удалось запустить временный контейнер для проверки монтирования.
        exit /b 2
    )

    for /f "delims=" %%a in ('docker exec !tmp! findstr /R /C:"auth\.register(" /app/src/server.js 2^>nul ^| find /c /v ""') do set count=%%a
    docker rm -f !tmp! >nul 2>&1

    if "!count!"=="ERR" (
        echo Ошибка: не удалось прочитать /app/src/server.js внутри контейнера.
        exit /b 2
    )

    if not "!count!"=="0" exit /b 1
    exit /b 0

:check_health
    REM Прямой запрос к nginx
    curl -fsS --max-time 3 "http://localhost:%PORT%/api/health" >nul 2>&1
    if not errorlevel 1 exit /b 0

    REM Проверка через backend контейнер
    for /f "delims=" %%a in ('%COMPOSE% ps -q backend 2^>nul') do set cid=%%a
    if "!cid!"=="" exit /b 1

    docker exec !cid! node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >nul 2>&1
    exit /b %errorlevel%
