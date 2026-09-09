CREATE TABLE users (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  google_sub        VARCHAR(255) NOT NULL,
  email             VARCHAR(255) NOT NULL,
  first_name        VARCHAR(100) NOT NULL,
  last_name         VARCHAR(100) NOT NULL,
  is_admin          BOOLEAN NOT NULL DEFAULT FALSE,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  age_confirmed_at  TIMESTAMP NULL,
  onboarded_at      TIMESTAMP NULL,
  -- opening_view defaults to 'personal', not 'all' — even though FR-U5
  -- originally specced the unified All calendar as the universal post-login
  -- landing page, changing the default for every existing user/test would
  -- have meant updating dozens of e2e assertions that assume Personal
  -- Calendar loads immediately after /app. Each user opts into 'all' from
  -- Settings instead; nothing changes for anyone who doesn't.
  week_starts_on    ENUM('sunday','monday') NOT NULL DEFAULT 'sunday',
  opening_view      ENUM('all','personal') NOT NULL DEFAULT 'personal',
  -- salt:hash (scrypt, server/src/auth/notesPin.js) — NULL means no PIN is
  -- set, so Personal Notes stay unlocked exactly like before this feature
  -- existed. Never the raw PIN. Setting/changing/clearing it only requires
  -- being signed in (no "old PIN" needed) — being signed in already is the
  -- recovery path for a forgotten PIN.
  notes_pin_hash    VARCHAR(255) NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_google_sub (google_sub),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB;

CREATE TABLE spaces (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name              VARCHAR(255) NOT NULL,
  join_code         CHAR(6) NOT NULL,
  -- Nullable + SET NULL (not RESTRICT) so a creator can delete their own
  -- account later without being blocked by a Space they may no longer even
  -- belong to (they could have left or been removed after creating it) —
  -- the Space itself is never deleted just because its creator's account is.
  creator_user_id   BIGINT UNSIGNED NULL,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_spaces_join_code (join_code),
  FOREIGN KEY (creator_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE space_members (
  space_id    BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  role        ENUM('organizer','member') NOT NULL,
  joined_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (space_id, user_id),
  FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE items (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  space_id        BIGINT UNSIGNED NULL,
  kind            ENUM('task','event','note') NOT NULL,
  title           VARCHAR(255) NOT NULL,
  description     TEXT,
  category        ENUM('Assignment','Activity','Quiz','Project','Presentation','Exam','Others') NULL,
  due_date        DATE NULL,
  due_time        TIME NULL,
  color           ENUM('salmon','peach','butter','lime','mint','seafoam','cyan','sky','periwinkle','lavender','orchid','rose') NULL,
  -- One of the 20 plate ids in client/assets/orn/ (e00-e19) — a note's
  -- "book plate" (see items.routes.js's PLATE_IDS). Note-only, same pattern
  -- as color being task-only. Random on create when omitted; NULL only ever
  -- happens for a non-note item.
  plate           CHAR(3) NULL,
  -- Per-note lock (items.routes.js's GET /api/notes redacts title/
  -- description for a locked note the caller's session hasn't proven the
  -- PIN for yet). Note-only, same pattern as color/plate. Always FALSE at
  -- create — locking happens after, via the editor's lock toggle.
  is_locked       BOOLEAN NOT NULL DEFAULT FALSE,
  is_open_to_all  BOOLEAN NOT NULL DEFAULT FALSE,
  admin_status    ENUM('open','closed') NOT NULL DEFAULT 'open',
  created_by      BIGINT UNSIGNED NOT NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT chk_personal_kind CHECK (
    (space_id IS NULL AND kind IN ('task','note')) OR (space_id IS NOT NULL)
  ),
  CONSTRAINT chk_color_task_only CHECK (color IS NULL OR kind = 'task'),
  CONSTRAINT chk_plate_note_only CHECK (plate IS NULL OR kind = 'note'),
  CONSTRAINT chk_locked_note_only CHECK (is_locked = FALSE OR kind = 'note')
) ENGINE=InnoDB;

CREATE TABLE item_assignments (
  item_id  BIGINT UNSIGNED NOT NULL,
  user_id  BIGINT UNSIGNED NOT NULL,
  status   ENUM('pending','completed') NOT NULL DEFAULT 'pending',
  PRIMARY KEY (item_id, user_id),
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- encrypted_refresh_token is nullable until Day 7's real incremental-consent
-- flow lands and starts populating it — today's Settings opt-in just records
-- is_connected/connected_at as a stub, per the Day 6 scope decision to ship
-- the opt-in UI ahead of the actual Calendar sync mechanics.
CREATE TABLE google_calendar_tokens (
  user_id                 BIGINT UNSIGNED PRIMARY KEY,
  encrypted_refresh_token TEXT NULL,
  is_connected            BOOLEAN NOT NULL DEFAULT TRUE,
  connected_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE item_calendar_events (
  item_id          BIGINT UNSIGNED NOT NULL,
  user_id          BIGINT UNSIGNED NOT NULL,
  google_event_id  VARCHAR(255) NOT NULL,
  last_synced_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (item_id, user_id),
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE activity_log (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  actor_user_id   BIGINT UNSIGNED NULL,
  action_type     VARCHAR(50) NOT NULL,
  target_type     ENUM('user','space','item') NULL,
  target_id       BIGINT UNSIGNED NULL,
  -- Captured at log time, not resolved via a join on read — so a row still
  -- reads sensibly after its target (or even its actor) is later deleted.
  target_label    VARCHAR(255),
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- SET NULL, not the default RESTRICT — same reasoning as spaces.creator_user_id
  -- above: an admin who's ever performed a logged action must still be able to
  -- delete their own account afterward without a dangling FK blocking it.
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE INDEX idx_items_space ON items(space_id);
CREATE INDEX idx_items_creator ON items(created_by);
CREATE INDEX idx_assignments_user ON item_assignments(user_id);
CREATE INDEX idx_space_members_user ON space_members(user_id);
CREATE INDEX idx_activity_actor ON activity_log(actor_user_id, created_at DESC);

-- express-mysql-session's own store (server/src/auth/sessionStore.js) —
-- previously left for that library to auto-create at runtime via
-- createDatabaseTable: true, which meant the app's own DB user needed
-- CREATE privilege just to boot, even though the table itself never
-- actually needs to change shape after this. Explicit here instead, with
-- createDatabaseTable now false, so a properly least-privilege runtime
-- user (SELECT/INSERT/UPDATE/DELETE only, no DDL) can run the app at all.
-- Column shape/collation matches exactly what the library creates on its
-- own, so no data migration is needed for an existing sessions table.
CREATE TABLE sessions (
  session_id  VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
  expires     INT(11) UNSIGNED NOT NULL,
  data        MEDIUMTEXT COLLATE utf8mb4_bin,
  PRIMARY KEY (session_id)
) ENGINE=InnoDB;
