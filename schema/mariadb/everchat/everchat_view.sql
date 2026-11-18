CREATE TABLE `everchat_view` (
  `chat` bigint(20) NOT NULL,
  `name` varchar(8) NOT NULL,
  `parts` mediumtext NOT NULL,
  `batch` tinyint(4) NOT NULL DEFAULT 0,
  `created` bigint(20) NOT NULL,
  `updated` bigint(20) NOT NULL,
  PRIMARY KEY (`chat`,`name`),
  CONSTRAINT `everchat_view_chat_fk` FOREIGN KEY (`chat`) REFERENCES `everchat_chat` (`id`) ON DELETE CASCADE,
  CONSTRAINT `everchat_view_ck1` CHECK (`name` in ('chat','seen')),
  CONSTRAINT `everchat_view_ck2` CHECK (`batch` in (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;
