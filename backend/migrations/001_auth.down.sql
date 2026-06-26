-- Roll back 001 — authentication foundation.
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS refresh_sessions;
DROP TABLE IF EXISTS mfa_devices;
DROP TABLE IF EXISTS users;
