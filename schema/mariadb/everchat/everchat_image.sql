CREATE TABLE `everchat_image` (
  `chat` bigint(20) NOT NULL,
  `n` bigint(20) NOT NULL,
  `name` varchar(64) NOT NULL,
  `type` varchar(127) NOT NULL,
  `width` int(11) NOT NULL,
  `height` int(11) NOT NULL,
  `source` varchar(8) NOT NULL,
  `created` bigint(20) NOT NULL,
  `bytes` mediumblob NOT NULL,
  PRIMARY KEY (`chat`,`n`),
  UNIQUE KEY `everchat_image_name` (`chat`,`name`),
  CONSTRAINT `everchat_image_chat_fk` FOREIGN KEY (`chat`) REFERENCES `everchat_chat` (`id`) ON DELETE CASCADE,
  CONSTRAINT `everchat_image_ck1` CHECK (`source` in ('person','tool'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;
