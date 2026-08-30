CREATE TABLE users (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  google_sub        VARCHAR(255) NOT NULL,
  email             VARCHAR(255) NOT NULL,
  first_name        VARCHAR(100) NOT NULL,
  last_name         VARCHAR(100) NOT NULL,
  is_admin          BOOLEAN NOT NULL DEFAULT FALSE,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  age_confirmed_at  TIMESTAMP NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_google_sub (google_sub),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB;

CREATE TABLE spaces (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name              VARCHAR(255) NOT NULL,
  join_code         CHAR(6) NOT NULL,
  creator_user_id   BIGINT UNSIGNED NOT NULL,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_spaces_join_code (join_code),
  FOREIGN KEY (creator_user_id) REFERENCES users(id)
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
  is_open_to_all  BOOLEAN NOT NULL DEFAULT FALSE,
  admin_status    ENUM('open','closed') NOT NULL DEFAULT 'open',
  created_by      BIGINT UNSIGNED NOT NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT chk_personal_kind CHECK (
    (space_id IS NULL AND kind IN ('task','note')) OR (space_id IS NOT NULL)
  )
) ENGINE=InnoDB;

CREATE TABLE item_assignments (
  item_id  BIGINT UNSIGNED NOT NULL,
  user_id  BIGINT UNSIGNED NOT NULL,
  status   ENUM('pending','completed') NOT NULL DEFAULT 'pending',
  PRIMARY KEY (item_id, user_id),
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE google_calendar_tokens (
  user_id                 BIGINT UNSIGNED PRIMARY KEY,
  encrypted_refresh_token TEXT NOT NULL,
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
  target_label    VARCHAR(255),
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (actor_user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE INDEX idx_items_space ON items(space_id);
CREATE INDEX idx_items_creator ON items(created_by);
CREATE INDEX idx_assignments_user ON item_assignments(user_id);
CREATE INDEX idx_space_members_user ON space_members(user_id);
CREATE INDEX idx_activity_actor ON activity_log(actor_user_id, created_at DESC);
