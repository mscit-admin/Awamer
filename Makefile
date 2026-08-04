# =====================================================================
# NetSphere Terminal — Makefile (Node.js backend)
# =====================================================================
# Uses relative paths so repos in directories with spaces still work.
# =====================================================================

SHELL := /bin/bash
.PHONY: help install backend-install backend-dev backend-build backend-typecheck \
        desktop-install desktop-dev desktop-build \
        migrate-up migrate-down migrate-up-docker migrate-down-docker \
        docker-up docker-down docker-logs docker-build docker-rebuild \
        test lint clean

DEFAULT_GOAL := help

COMPOSE := docker compose --env-file .env -f deployments/docker-compose.yml

CYAN := \033[36m
NC := \033[0m

help: ## Show this help
	@echo "NetSphere Terminal — Make targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  $(CYAN)%-22s$(NC) %s\n", $$1, $$2}'

# --- Setup ------------------------------------------------------------
install: backend-install desktop-install ## Install all deps

backend-install: ## Install backend npm deps
	cd backend && npm install

desktop-install: ## Install desktop npm deps
	cd desktop && npm install

# --- Backend (host Node required) ------------------------------------
backend-dev: ## Run backend in dev mode with auto-reload
	cd backend && npm run dev

backend-build: ## Compile TypeScript
	cd backend && npm run build

backend-typecheck: ## Run typecheck only
	cd backend && npm run typecheck

# --- Desktop ----------------------------------------------------------
desktop-dev: ## Run desktop app in dev mode (Tauri)
	cd desktop && npm run tauri dev

desktop-build: ## Build desktop app for current platform
	cd desktop && npm run tauri build

# --- Database — host Node path ---------------------------------------
migrate-up: ## Apply migrations using host Node
	cd backend && npm run migrate:up

migrate-down: ## Roll back the last migration using host Node
	cd backend && npm run migrate:down

# --- Database — Docker path ------------------------------------------
migrate-up-docker: ## Apply migrations using the auth-service container
	$(COMPOSE) build auth-service
	$(COMPOSE) run --rm --no-deps auth-service node dist/migrate.js up

migrate-down-docker: ## Roll back last migration via container
	$(COMPOSE) run --rm --no-deps auth-service node dist/migrate.js down

# --- Docker -----------------------------------------------------------
docker-build: ## Build all images
	$(COMPOSE) build

docker-rebuild: ## Force rebuild from scratch
	$(COMPOSE) build --no-cache

docker-up: ## Start all services
	$(COMPOSE) up -d

docker-down: ## Stop all services
	$(COMPOSE) down

docker-logs: ## Tail docker logs
	$(COMPOSE) logs -f

# --- Quality ----------------------------------------------------------
test: ## Run backend + desktop test suites
	cd backend && npm test
	cd desktop && npm test

lint: ## Typecheck + lint backend, desktop, and the Rust crate
	cd backend && npm run typecheck && npm run lint
	cd desktop && npx tsc --noEmit && npm run lint
	cd desktop/src-tauri && cargo check

clean: ## Remove build artifacts
	rm -rf backend/dist backend/node_modules
	rm -rf desktop/dist desktop/node_modules desktop/src-tauri/target
	@echo "✔ Cleaned"
