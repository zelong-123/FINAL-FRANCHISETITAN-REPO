-- phpMyAdmin SQL Dump
-- version 5.2.1
--
-- Host: 127.0.0.1:3306
-- Generation Time: Nov 05, 2026 at 05:21 AM
-- Server version: 10.4.32-MariaDB

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";

/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `franchise_titan`
--
-- Made-up data for tests/import. Every awkward case the importer must handle is here on purpose.

CREATE TABLE `roles` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `name` varchar(255) NOT NULL,
  `label` varchar(255) NOT NULL,
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `roles` (`id`, `name`, `label`, `created_at`, `updated_at`) VALUES
(1, 'marketing', 'Marketing Personnel', '2026-01-01 00:00:00', '2026-01-01 00:00:00'),
(3, 'admin', 'Administrator', '2026-01-01 00:00:00', '2026-01-01 00:00:00');

CREATE TABLE `users` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `role_id` bigint(20) UNSIGNED NOT NULL,
  `full_name` varchar(255) NOT NULL,
  `email` varchar(255) NOT NULL,
  `password` varchar(255) NOT NULL,
  `remember_token` varchar(100) DEFAULT NULL,
  `old_nickname` varchar(20) DEFAULT NULL,
  `account_status` varchar(20) NOT NULL DEFAULT 'active',
  `archived_by_user_id` bigint(20) UNSIGNED DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- User 1 was archived by a user further down the file, and user 2 by themself. User 3 and 4 differ
-- only by letter case. User 5 has an unusable hash. User 6 points at a user who no longer exists.
-- User 7's role is gone, which also takes user 7's session with it.
INSERT INTO `users` (`id`, `role_id`, `full_name`, `email`, `password`, `remember_token`, `old_nickname`, `account_status`, `archived_by_user_id`, `created_at`, `updated_at`) VALUES
(1, 3, 'Ana Admin', 'ana@example.test', '$2y$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123.', 'x', 'an', 'active', 2, '2026-01-02 03:04:05', '2026-01-02 03:04:05'),
(2, 1, 'Ben Marketing', 'ben@example.test', '$2y$12$bbcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123.', NULL, NULL, 'active', 2, '2026-01-02 03:04:05', '2026-01-02 03:04:05'),
(3, 1, 'Cy Upper', 'Cy@Example.test', '$2y$12$cbcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123.', NULL, NULL, 'active', NULL, '2026-01-02 03:04:05', '2026-01-02 03:04:05'),
(4, 1, 'Cy Lower', 'cy@example.test', '$2y$12$dbcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123.', NULL, NULL, 'active', NULL, '2026-01-02 03:04:05', '2026-01-02 03:04:05'),
(5, 1, 'Di Hashless', 'di@example.test', 'not-a-hash', NULL, NULL, 'active', NULL, '2026-01-02 03:04:05', '2026-01-02 03:04:05'),
(6, 1, 'Ed Orphan', 'ed@example.test', '$2b$12$ebcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123.', NULL, NULL, 'active', 99, '2026-01-02 03:04:05', '2026-01-02 03:04:05'),
(7, 42, 'Flo Noroles', 'flo@example.test', '$2y$12$fbcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123.', NULL, NULL, 'active', NULL, '2026-01-02 03:04:05', '2026-01-02 03:04:05');

CREATE TABLE `brands` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `name` varchar(255) NOT NULL,
  `code` varchar(255) NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `brands` (`id`, `name`, `code`, `is_active`) VALUES
(1, 'Active Brand', 'ACT', 1),
(2, 'Old Brand', 'OLD', 0);

CREATE TABLE `brand_products` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `brand_id` bigint(20) UNSIGNED NOT NULL,
  `sku` varchar(255) NOT NULL,
  `name` varchar(255) NOT NULL,
  `name_key` varchar(255) NOT NULL,
  `image_path` varchar(255) DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 0,
  `created_by_user_id` bigint(20) UNSIGNED NOT NULL,
  `updated_by_user_id` bigint(20) UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `brand_products` (`id`, `brand_id`, `sku`, `name`, `name_key`, `image_path`, `is_active`, `created_by_user_id`, `updated_by_user_id`) VALUES
(1, 1, 'SKU-1', 'Picture Product', 'picture product', 'brand-products/p.jpg', 1, 1, 1);

CREATE TABLE `documents` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `documentable_type` varchar(255) NOT NULL,
  `documentable_id` bigint(20) UNSIGNED NOT NULL,
  `type` varchar(255) NOT NULL,
  `original_name` varchar(255) NOT NULL,
  `stored_name` varchar(255) NOT NULL,
  `disk` varchar(255) NOT NULL DEFAULT 'private',
  `path` varchar(255) NOT NULL,
  `mime_type` varchar(255) DEFAULT NULL,
  `size_bytes` bigint(20) NOT NULL DEFAULT 0,
  `uploaded_by_user_id` bigint(20) UNSIGNED NOT NULL,
  `metadata` longtext DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Document 1 has every string escape, and JSON whose digits must survive. Document 2 has broken JSON
-- and no file on disk. Document 3's uploader is gone and the column is required. Document 4 uses a
-- disk with no bucket.
INSERT INTO `documents` (`id`, `documentable_type`, `documentable_id`, `type`, `original_name`, `stored_name`, `disk`, `path`, `mime_type`, `size_bytes`, `uploaded_by_user_id`, `metadata`) VALUES
(1, 'App\\Models\\Applicant', 9, 'loi', 'it\'s; a (test), "x" \'\'q\'\' C:\\dir\nline2 café 😀', 'a.png', 'private', 'applicants/1/loi/a.png', 'image/png', 3, 1, '{"amount":1.10,"note":"a \\"quoted\\" word","nested":{"ok":true}}'),
(2, 'App\\Models\\Applicant', 9, 'loi', 'two.png', 'b.png', 'private', 'applicants/1/loi/missing.png', NULL, 3, 1, '{not json'),
(3, 'App\\Models\\Applicant', 9, 'loi', 'three.png', 'c.png', 'private', 'applicants/1/loi/c.png', NULL, 3, 99, NULL),
(4, 'App\\Models\\Applicant', 9, 'loi', 'four.png', 'd.png', 'local', 'old/d.png', NULL, 3, 1, NULL);

CREATE TABLE `schedule_sessions` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `activity_type` varchar(40) NOT NULL,
  `start_at` datetime NOT NULL,
  `end_at` datetime NOT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'pending',
  `merge_suggested` tinyint(1) NOT NULL DEFAULT 0,
  `max_capacity` int(11) NOT NULL,
  `merged_into_session_id` bigint(20) UNSIGNED DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- DATETIME columns keep Manila wall-clock; TIMESTAMP columns come out of this export in UTC.
INSERT INTO `schedule_sessions` (`id`, `activity_type`, `start_at`, `end_at`, `status`, `merge_suggested`, `max_capacity`, `merged_into_session_id`, `created_at`, `updated_at`) VALUES
(1, 'orientation', '2026-11-19 11:00:00', '2026-11-19 12:00:00', 'pending', 0, 5, 2, '2026-11-04 21:51:12', '2026-11-04 21:51:12'),
(2, 'orientation', '2026-11-20 09:30:00', '2026-11-20 10:30:00', 'pending', 1, 5, NULL, '2026-11-04 21:51:12', '2026-11-04 21:51:12');

CREATE TABLE `user_sessions` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `user_id` bigint(20) UNSIGNED NOT NULL,
  `session_key` varchar(100) NOT NULL,
  `ended_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `user_sessions` (`id`, `user_id`, `session_key`, `ended_at`) VALUES
(1, 1, 'zero-date', '0000-00-00 00:00:00'),
(2, 7, 'owner-skipped', NULL);

CREATE TABLE `api_tokens` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `token_hash` varchar(64) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `api_tokens` (`id`, `token_hash`) VALUES
(1, 'abc');

CREATE TABLE `legacy_notes` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `note` text DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `legacy_notes` (`id`, `note`) VALUES
(1, 'not in the new schema');

ALTER TABLE `schedule_sessions`
  ADD PRIMARY KEY (`id`);

ALTER TABLE `schedule_sessions`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=50;

ALTER TABLE `users`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;
COMMIT;
