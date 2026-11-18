CREATE TABLE `everchat_turn_item` (
  `chat` bigint(20) NOT NULL,
  `turn` bigint(20) NOT NULL,
  `n` bigint(20) NOT NULL,
  `kind` varchar(8) NOT NULL,
  `body` longtext NOT NULL,
  `created` bigint(20) NOT NULL,
  PRIMARY KEY (`chat`,`turn`,`n`),
  CONSTRAINT `everchat_turn_item_chat_fk` FOREIGN KEY (`chat`) REFERENCES `everchat_chat` (`id`) ON DELETE CASCADE,
  CONSTRAINT `everchat_turn_item_turn_fk` FOREIGN KEY (`chat`, `turn`) REFERENCES `everchat_turn` (`chat`, `n`) ON DELETE CASCADE,
  CONSTRAINT `everchat_turn_item_ck1` CHECK (`kind` in ('user','turn','back'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;
