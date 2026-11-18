CREATE TABLE `everchat_pick` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `vendor` varchar(64) NOT NULL,
  `model` varchar(128) NOT NULL,
  `effort` varchar(32) NOT NULL,
  `speed` varchar(32) NOT NULL,
  `created` bigint(20) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `everchat_pick_choice` (`vendor`,`model`,`effort`,`speed`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;
