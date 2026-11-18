CREATE TABLE `everchat_launch` (
  `chat` bigint(20) NOT NULL,
  `n` bigint(20) NOT NULL,
  `pid` int(11) NOT NULL,
  `host` varchar(255) NOT NULL,
  `cwd` text NOT NULL,
  `version` varchar(64) NOT NULL,
  `run_tag` varchar(64) NOT NULL,
  `pick` bigint(20) DEFAULT NULL,
  `created` bigint(20) NOT NULL,
  `ended` bigint(20) DEFAULT NULL,
  `why` varchar(16) DEFAULT NULL,
  `live` tinyint(4) GENERATED ALWAYS AS (if(`ended` is null,1,NULL)) VIRTUAL,
  PRIMARY KEY (`chat`,`n`),
  UNIQUE KEY `everchat_launch_live` (`chat`,`live`),
  KEY `everchat_launch_pick_fk` (`pick`),
  CONSTRAINT `everchat_launch_chat_fk` FOREIGN KEY (`chat`) REFERENCES `everchat_chat` (`id`) ON DELETE CASCADE,
  CONSTRAINT `everchat_launch_pick_fk` FOREIGN KEY (`pick`) REFERENCES `everchat_pick` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;
