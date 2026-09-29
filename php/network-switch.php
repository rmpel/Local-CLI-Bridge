<?php
/**
 * Switch an existing network between subdirectory and subdomain mode.
 *
 * Usage (through `wp eval-file`): network-switch.php <subdir|subdomain> [plan|apply]
 *
 * Neither WordPress nor WP-CLI can do this, so every sub-site's row in
 * wp_blogs and its home/siteurl options are rewritten here. Only sub-sites
 * whose address is derived from the network domain can be mapped:
 *   subdir -> subdomain:  example.test/blog/  ->  blog.example.test/
 *   subdomain -> subdir:  blog.example.test/  ->  example.test/blog/
 * Anything else (a mapped custom domain, a nested path) aborts the whole
 * switch before anything is written. Output is one JSON object; a refusal
 * has ok=false and an error message.
 *
 * The SUBDOMAIN_INSTALL constant in wp-config.php is flipped by the caller
 * (`wp config set`) after this script succeeds.
 *
 * Package: Local CLI Bridge
 * License: GPL-3.0-or-later
 */

if ( ! defined( 'ABSPATH' ) ) {
	fwrite( STDERR, "WordPress is not loaded.\n" );
	exit( 1 );
}

$target = isset( $args[0] ) ? $args[0] : '';
$action = isset( $args[1] ) ? $args[1] : 'plan';

// Refusals are structured results, not crashes: exit 0 so the caller gets the JSON.
$fail = function ( $message, $extra = array() ) {
	echo wp_json_encode( array_merge( array( 'ok' => false, 'error' => $message ), $extra ) );
	exit( 0 );
};

if ( ! in_array( $target, array( 'subdir', 'subdomain' ), true ) ) {
	$fail( 'Target must be "subdir" or "subdomain".' );
}
if ( ! is_multisite() ) {
	$fail( 'This site is not a multisite network.' );
}

$to_subdomain = ( 'subdomain' === $target );
$network      = get_network();
$net_domain   = $network->domain;
$net_path     = $network->path ? $network->path : '/';
$main_blog_id = (int) $network->blog_id;

if ( is_subdomain_install() === $to_subdomain ) {
	echo wp_json_encode( array( 'ok' => true, 'changed' => false, 'plan' => array() ) );
	exit( 0 );
}

$plan   = array();
$errors = array();

foreach ( get_sites( array( 'number' => 0 ) ) as $site ) {
	$blog_id = (int) $site->blog_id;
	if ( $blog_id === $main_blog_id ) {
		continue;
	}
	$from = array( 'domain' => $site->domain, 'path' => $site->path );

	if ( $to_subdomain ) {
		if ( strtolower( $site->domain ) !== strtolower( $net_domain ) || 0 !== strpos( $site->path, $net_path ) ) {
			$errors[] = sprintf( 'Blog %d (%s%s) is not a subdirectory of %s%s.', $blog_id, $site->domain, $site->path, $net_domain, $net_path );
			continue;
		}
		$slug = trim( substr( $site->path, strlen( $net_path ) ), '/' );
		if ( '' === $slug || false !== strpos( $slug, '/' ) ) {
			$errors[] = sprintf( 'Blog %d (%s%s) has a nested or empty path and cannot become a subdomain.', $blog_id, $site->domain, $site->path );
			continue;
		}
		$to = array( 'domain' => $slug . '.' . $net_domain, 'path' => $net_path );
	} else {
		$suffix = '.' . strtolower( $net_domain );
		$domain = strtolower( $site->domain );
		if ( substr( $domain, -strlen( $suffix ) ) !== $suffix || $site->path !== $net_path ) {
			$errors[] = sprintf( 'Blog %d (%s%s) is not a direct subdomain of %s (a mapped domain?).', $blog_id, $site->domain, $site->path, $net_domain );
			continue;
		}
		$label = substr( $domain, 0, -strlen( $suffix ) );
		if ( '' === $label || false !== strpos( $label, '.' ) ) {
			$errors[] = sprintf( 'Blog %d (%s%s) is not a direct subdomain of %s.', $blog_id, $site->domain, $site->path, $net_domain );
			continue;
		}
		$to = array( 'domain' => $net_domain, 'path' => $net_path . $label . '/' );
	}

	$plan[] = array( 'blog_id' => $blog_id, 'from' => $from, 'to' => $to );
}

if ( $errors ) {
	$fail( 'Some sub-sites cannot be mapped mechanically; nothing was changed.', array( 'errors' => $errors, 'plan' => $plan ) );
}

if ( 'apply' !== $action ) {
	echo wp_json_encode( array( 'ok' => true, 'changed' => false, 'dryRun' => true, 'plan' => $plan ) );
	exit( 0 );
}

global $wpdb;

foreach ( $plan as $item ) {
	$updated = $wpdb->update(
		$wpdb->blogs,
		array( 'domain' => $item['to']['domain'], 'path' => $item['to']['path'] ),
		array( 'blog_id' => $item['blog_id'] )
	);
	if ( false === $updated ) {
		$fail( sprintf( 'Updating %s for blog %d failed: %s', $wpdb->blogs, $item['blog_id'], $wpdb->last_error ), array( 'plan' => $plan ) );
	}

	switch_to_blog( $item['blog_id'] );
	foreach ( array( 'home', 'siteurl' ) as $option ) {
		$old    = (string) get_option( $option );
		$scheme = wp_parse_url( $old, PHP_URL_SCHEME );
		$scheme = $scheme ? $scheme : 'http';
		update_option( $option, $scheme . '://' . $item['to']['domain'] . rtrim( $item['to']['path'], '/' ) );
	}
	restore_current_blog();
	clean_blog_cache( $item['blog_id'] );
}

update_site_option( 'subdomain_install', $to_subdomain ? 1 : 0 );
wp_cache_flush();

echo wp_json_encode( array( 'ok' => true, 'changed' => true, 'plan' => $plan ) );
