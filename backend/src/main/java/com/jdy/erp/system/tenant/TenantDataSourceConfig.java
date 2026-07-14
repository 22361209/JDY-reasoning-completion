package com.jdy.erp.system.tenant;

import javax.sql.DataSource;

import com.zaxxer.hikari.HikariDataSource;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.jdbc.DataSourceProperties;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.PlatformTransactionManager;

@Configuration
public class TenantDataSourceConfig {
    @Bean(name = "platformDataSource", destroyMethod = "close")
    @ConfigurationProperties("spring.datasource.hikari")
    public HikariDataSource platformDataSource(DataSourceProperties properties) {
        return properties.initializeDataSourceBuilder().type(HikariDataSource.class).build();
    }

    @Bean
    @Primary
    public DataSource dataSource(
        @Qualifier("platformDataSource") DataSource platformDataSource,
        TenantDataSourceRegistry tenantDataSourceRegistry
    ) {
        return new TenantRoutingDataSource(platformDataSource, tenantDataSourceRegistry);
    }

    @Bean
    @Primary
    public JdbcTemplate jdbcTemplate(DataSource dataSource) {
        return new JdbcTemplate(dataSource);
    }

    @Bean(name = "platformJdbcTemplate")
    public JdbcTemplate platformJdbcTemplate(@Qualifier("platformDataSource") DataSource platformDataSource) {
        return new JdbcTemplate(platformDataSource);
    }

    @Bean
    @Primary
    public PlatformTransactionManager transactionManager(DataSource dataSource) {
        return new DataSourceTransactionManager(dataSource);
    }

    @Bean(name = "platformTransactionManager")
    public PlatformTransactionManager platformTransactionManager(@Qualifier("platformDataSource") DataSource platformDataSource) {
        return new DataSourceTransactionManager(platformDataSource);
    }
}
