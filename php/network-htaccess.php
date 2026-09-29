<?php
/**
 * Print the Apache rewrite rules WordPress itself shows on the Network Setup
 * screen for this site's network type. Run through `wp eval-file`, after the
 * network exists, so network_step2() reads the type from the database.
 *
 * Core only builds the rules inside network_step2(), which echoes the whole
 * admin screen, so the rules are cut out of its <textarea>. Prints nothing
 * when that fails; the caller then falls back to its static copy.
 *
 * Package: Local CLI Bridge
 * License: GPL-3.0-or-later
 */

if ( ! defined( 'ABSPATH' ) ) {
	fwrite( STDERR, "WordPress is not loaded.\n" );
	exit( 1 );
}

// network_step2() derives RewriteBase from DOCUMENT_ROOT, which is empty under WP-CLI.
$_SERVER['DOCUMENT_ROOT'] = rtrim( ABSPATH, '/\\' );
$GLOBALS['is_nginx']      = false; // Force the Apache branch.
$GLOBALS['is_iis7']       = false;

require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/network.php';

ob_start();
network_step2();
$html = ob_get_clean();

if ( preg_match( '#<textarea id="network-htaccess-rules"[^>]*>(.*?)</textarea>#s', $html, $m ) ) {
	echo html_entity_decode( $m[1], ENT_QUOTES, 'UTF-8' );
}
