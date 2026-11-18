CREATE TABLE `everchat_kind` (
  `id` tinyint(4) NOT NULL,
  `name` varchar(16) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `everchat_kind_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;
