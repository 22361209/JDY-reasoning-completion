package com.jdy.erp.system.security;

import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

@Component
public class PasswordPolicy {
    public void validate(String password) {
        if (password == null || password.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "密码不能为空");
        }
        if (password.length() < 8) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "密码至少 8 位");
        }
        if (!password.matches(".*[A-Z].*")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "密码需包含大写字母");
        }
        if (!password.matches(".*[a-z].*")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "密码需包含小写字母");
        }
        if (!password.matches(".*\\d.*")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "密码需包含数字");
        }
        if (!password.matches(".*[^A-Za-z0-9].*")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "密码需包含符号");
        }
    }
}
