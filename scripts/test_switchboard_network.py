import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('sb_network', Path(__file__).with_name('switchboard-network.py'))
sb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sb)


class PublicHttpControlTests(unittest.TestCase):
    def test_bounded_tls_verified_no_proxy_or_redirect(self):
        args = sb.curl_args(sb.FIRST + sb.HEALTH, '141.95.35.110', '/tmp/body')
        self.assertEqual(args[:3], ['curl', '-q', '-4'])
        for flag in ('--resolve', '--noproxy', '--proto', '--max-time', '--max-filesize'):
            self.assertIn(flag, args)
        for flag in ('-k', '--insecure', '-L', '--location'):
            self.assertNotIn(flag, args)
        self.assertIn('--compressed', sb.curl_args(sb.FIRST + sb.HEALTH, '141.95.35.110', '/tmp/body', True))

    def test_fixed_targets_and_public_ips_only(self):
        for address in ('127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '192.0.0.8', '224.0.0.1', '::1'):
            with self.assertRaises(ValueError):
                sb.curl_args(sb.FIRST + sb.HEALTH, address, '/tmp/body')
        with self.assertRaises(ValueError):
            sb.curl_args('https://untrusted.example.com', '8.8.8.8', '/tmp/body')

    def test_headers_and_partial_body_are_not_success(self):
        result = sb.summarize(json.dumps({'http_code': 200, 'content_type': 'application/json'}), b'{"oracles":[', 28)
        self.assertFalse(result['completeHealthResponse'])
        self.assertFalse(result['bodyJson'])
        self.assertEqual(result['bodyBytes'], 12)

    def test_even_parseable_json_requires_transfer_end(self):
        meta = json.dumps({'http_code': 200})
        self.assertFalse(sb.summarize(meta, b'{"oracles":[]}', 28)['completeHealthResponse'])
        self.assertTrue(sb.summarize(meta, b'{"oracles":[]}', 0)['completeHealthResponse'])
        self.assertFalse(sb.summarize(meta, b'{"status":"ok"}', 0)['completeHealthResponse'])

    def test_response_prose_and_headers_are_not_reported(self):
        result = sb.summarize(json.dumps({'http_code': 502, 'errormsg': 'PRIVATE', 'content_type': 'PRIVATE',
                                          'url_effective': 'https://PRIVATE'}), b'PRIVATE', 0)
        self.assertNotIn('PRIVATE', json.dumps(result))
        self.assertEqual(result['contentType'], 'other')
        self.assertEqual(sb.summarize('not json', b'', 1).get('httpStatus'), None)
        self.assertFalse(sb.summarize('{}', b'x' * (sb.LIMIT + 1), 0)['bodyJson'])

    def test_dns_failure_does_not_launch_curl(self):
        with patch.object(sb.socket, 'getaddrinfo', side_effect=sb.socket.gaierror('PRIVATE')), patch.object(sb.subprocess, 'run') as run:
            result = sb.probe(sb.TARGETS[0])
            self.assertEqual(result['code'], 'dns_unavailable')
            self.assertNotIn('PRIVATE', json.dumps(result))
            run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
