CREATE TABLE `everchat_log` (
  `chat` bigint(20) NOT NULL,
  `n` bigint(20) NOT NULL,
  `level` varchar(8) NOT NULL,
  `source` varchar(64) NOT NULL,
  `text` mediumtext NOT NULL,
  `launch` bigint(20) NOT NULL,
  `created` bigint(20) NOT NULL,
  PRIMARY KEY (`chat`,`n`),
  KEY `everchat_log_launch_fk` (`chat`,`launch`),
  CONSTRAINT `everchat_log_chat_fk` FOREIGN KEY (`chat`) REFERENCES `everchat_chat` (`id`) ON DELETE CASCADE,
  CONSTRAINT `everchat_log_launch_fk` FOREIGN KEY (`chat`, `launch`) REFERENCES `everchat_launch` (`chat`, `n`) ON DELETE CASCADE,
  CONSTRAINT `everchat_log_ck1` CHECK (`level` in ('debug','info','warn','error'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;
