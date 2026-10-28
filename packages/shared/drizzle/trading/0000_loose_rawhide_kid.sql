CREATE TABLE `analyst_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`signal_id` integer NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`verdict` text,
	`confidence` real,
	`rationale` text,
	`latency_ms` integer,
	`cost_usd` real,
	`used_for_decision` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`signal_id`) REFERENCES `signals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `decisions` (
	`signal_id` integer PRIMARY KEY NOT NULL,
	`verdict` text NOT NULL,
	`killed_by` text,
	`all_failed_json` text,
	`decided_at` integer NOT NULL,
	FOREIGN KEY (`signal_id`) REFERENCES `signals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `events_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`level` text NOT NULL,
	`stage` text NOT NULL,
	`message` text NOT NULL,
	`data_json` text
);
--> statement-breakpoint
CREATE TABLE `fills` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`position_id` integer NOT NULL,
	`side` text NOT NULL,
	`qty` real NOT NULL,
	`price` real NOT NULL,
	`fee_usd` real NOT NULL,
	`tx_sig` text,
	`simulated` integer NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`position_id`) REFERENCES `positions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `positions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`signal_id` integer NOT NULL,
	`mode` text NOT NULL,
	`mint` text NOT NULL,
	`size_usd` real NOT NULL,
	`entry_price` real NOT NULL,
	`entry_at` integer NOT NULL,
	`stop_price` real NOT NULL,
	`tp_plan_json` text NOT NULL,
	`status` text NOT NULL,
	`exit_price` real,
	`exit_at` integer,
	`exit_reason` text,
	`gross_pnl_usd` real,
	`fees_usd` real,
	`slippage_bps` real,
	`net_pnl_usd` real,
	`net_pnl_pct` real,
	FOREIGN KEY (`signal_id`) REFERENCES `signals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `positions_one_open_per_mint` ON `positions` (`mint`) WHERE status = 'open';--> statement-breakpoint
CREATE TABLE `rule_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`signal_id` integer NOT NULL,
	`rule_id` text NOT NULL,
	`passed` integer NOT NULL,
	`value` text,
	`threshold` text,
	`reason` text,
	FOREIGN KEY (`signal_id`) REFERENCES `signals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `rule_results_signal_idx` ON `rule_results` (`signal_id`);--> statement-breakpoint
CREATE TABLE `signals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`wallet` text NOT NULL,
	`mint` text NOT NULL,
	`side` text NOT NULL,
	`amount_sol` real,
	`amount_token` real,
	`tx_sig` text NOT NULL,
	`block_time` integer,
	`detected_at` integer NOT NULL,
	`detect_latency_ms` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `signals_tx_sig_unique` ON `signals` (`tx_sig`);--> statement-breakpoint
CREATE INDEX `signals_mint_idx` ON `signals` (`mint`);--> statement-breakpoint
CREATE INDEX `signals_wallet_idx` ON `signals` (`wallet`);--> statement-breakpoint
CREATE TABLE `token_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`signal_id` integer NOT NULL,
	`mint` text NOT NULL,
	`taken_at` integer NOT NULL,
	`price_usd` real,
	`liquidity_usd` real,
	`fdv_usd` real,
	`pair_address` text,
	`pair_created_at` integer,
	`price_change_5m` real,
	`price_change_45m` real,
	`top10_pct` real,
	`dev_pct` real,
	`bundled_pct` real,
	`mint_authority_revoked` integer,
	`freeze_authority_revoked` integer,
	`lp_locked_pct` real,
	`raw_json` text,
	FOREIGN KEY (`signal_id`) REFERENCES `signals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `wallets` (
	`address` text PRIMARY KEY NOT NULL,
	`label` text,
	`source` text,
	`added_at` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`score` real,
	`notes` text
);
