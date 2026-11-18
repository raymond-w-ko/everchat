CREATE TABLE `everchat_head` (
  `chat` bigint(20) NOT NULL,
  `n` bigint(20) NOT NULL,
  `hash` char(64) NOT NULL,
  `body` longtext NOT NULL,
  `created` bigint(20) NOT NULL,
  PRIMARY KEY (`chat`,`n`),
  UNIQUE KEY `everchat_head_hash` (`chat`,`hash`),
  CONSTRAINT `everchat_head_chat_fk` FOREIGN KEY (`chat`) REFERENCES `everchat_chat` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;
