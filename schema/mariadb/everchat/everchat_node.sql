CREATE TABLE `everchat_node` (
  `chat` bigint(20) NOT NULL,
  `l` int(11) NOT NULL,
  `i` bigint(20) NOT NULL,
  `text` text NOT NULL,
  `size` int(11) NOT NULL,
  `created` bigint(20) NOT NULL,
  PRIMARY KEY (`chat`,`l`,`i`),
  CONSTRAINT `everchat_node_chat_fk` FOREIGN KEY (`chat`) REFERENCES `everchat_chat` (`id`) ON DELETE CASCADE,
  CONSTRAINT `everchat_node_ck1` CHECK (`l` >= 0),
  CONSTRAINT `everchat_node_ck2` CHECK (`i` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;
