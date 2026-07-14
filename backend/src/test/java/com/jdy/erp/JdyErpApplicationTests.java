package com.jdy.erp;

import static org.assertj.core.api.Assertions.assertThat;

import com.zaxxer.hikari.HikariDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;

@SpringBootTest(properties = {
	"spring.datasource.hikari.minimum-idle=0",
	"spring.datasource.hikari.maximum-pool-size=3"
})
class JdyErpApplicationTests {
	@Autowired
	@Qualifier("platformDataSource")
	private HikariDataSource platformDataSource;

	@Test
	void contextLoads() {
		assertThat(platformDataSource.getMinimumIdle()).isZero();
		assertThat(platformDataSource.getMaximumPoolSize()).isEqualTo(3);
	}

}
