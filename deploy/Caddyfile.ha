{$SEMS_DOMAIN} {
	encode gzip
	request_body { max_size 9MB }
	reverse_proxy sems-1:4000 sems-2:4000 sems-3:4000 {
		lb_policy least_conn
		lb_try_duration 5s
		health_uri /api/ready
		health_interval 5s
		health_timeout 2s
		fail_duration 30s
	}
}
