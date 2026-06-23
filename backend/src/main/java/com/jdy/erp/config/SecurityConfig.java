package com.jdy.erp.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
@EnableConfigurationProperties(SecurityConfig.SecurityProperties.class)
public class SecurityConfig {

    @Bean
    SecurityFilterChain securityFilterChain(HttpSecurity http, SecurityProperties properties) throws Exception {
        http.csrf(csrf -> csrf.disable());
        http.authorizeHttpRequests(auth -> {
            auth.requestMatchers("/actuator/health/**", "/api/system/health").permitAll();
            if (properties.devOpenApi()) {
                auth.requestMatchers("/api/**").permitAll();
            }
            auth.anyRequest().authenticated();
        });
        return http.build();
    }

    @ConfigurationProperties(prefix = "jdy.security")
    public record SecurityProperties(boolean devOpenApi) {
    }
}
