package com.jdy.erp;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class JdyErpApplication {

	public static void main(String[] args) {
		SpringApplication.run(JdyErpApplication.class, args);
	}

}
