CREATE TABLE `everchat_msg_image` (
  `chat` bigint(20) NOT NULL,
  `msg` bigint(20) NOT NULL,
  `n` bigint(20) NOT NULL,
  `image` bigint(20) NOT NULL,
  PRIMARY KEY (`chat`,`msg`,`n`),
  KEY `everchat_msg_image_image_fk` (`chat`,`image`),
  CONSTRAINT `everchat_msg_image_chat_fk` FOREIGN KEY (`chat`) REFERENCES `everchat_chat` (`id`) ON DELETE CASCADE,
  CONSTRAINT `everchat_msg_image_image_fk` FOREIGN KEY (`chat`, `image`) REFERENCES `everchat_image` (`chat`, `n`) ON DELETE CASCADE,
  CONSTRAINT `everchat_msg_image_msg_fk` FOREIGN KEY (`chat`, `msg`) REFERENCES `everchat_msg` (`chat`, `i`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;
