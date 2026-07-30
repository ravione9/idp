-- ============================================================
-- Migration 008 — Expand local_accounts.role for directory users
-- ============================================================
-- Allows non-admin local identities (USER, MANAGER, HRBP) to sign in
-- via email/password while keeping ADMIN / SUPER_ADMIN for console operators.

ALTER TABLE local_accounts
  MODIFY COLUMN role ENUM('USER','MANAGER','HRBP','ADMIN','SUPER_ADMIN')
    NOT NULL DEFAULT 'USER';
