import importlib.util
import unittest
from pathlib import Path

source = Path(__file__).parent / 'collect-workbench-jin10.py'
if not source.exists():
    source = Path(__file__).parents[1] / 'scripts' / 'collect-workbench-jin10.py'
spec = importlib.util.spec_from_file_location('jin10_collector', source)
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)
NOW = 1791763200


class Jin10CollectorTests(unittest.TestCase):
    def test_general_flash_keeps_non_agriculture_and_original_time(self):
        rows = collector.normalize([{'content': '<b>央行利率</b><script>ignore</script>', 'time': NOW, 'url': 'https://example.com/flash/1'}], NOW)
        self.assertEqual(rows[0]['title'], '央行利率')
        self.assertEqual(rows[0]['source'], 'Jin10 MCP')
        self.assertEqual(rows[0]['epoch'], NOW)
        self.assertNotIn('confirmedPriority', rows[0])

    def test_invalid_future_dates_and_unsafe_links(self):
        rows = collector.normalize([{'title': 'invalid', 'time': 'invalid'}, {'title': 'future', 'time': NOW + 3600},
                                    {'title': 'valid', 'time': NOW, 'url': 'https://user:password@example.com/a'}], NOW)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['url'], '')

    def test_failure_preserves_last_success_and_rows_with_backoff(self):
        old = collector.update_cache({}, [{'title': 'first', 'time': NOW}], NOW)
        failed = collector.update_cache(old, None, NOW + 120)
        self.assertEqual(failed['news'], old['news'])
        self.assertEqual(failed['last_success'], old['last_success'])
        self.assertEqual(failed['status'], 'UNAVAILABLE')
        self.assertEqual(failed['next_attempt_after'], NOW + 420)

    def test_merges_deduplicates_and_retains_other_cache_rows(self):
        old = collector.update_cache({}, [{'title': 'first', 'time': NOW, 'url': 'https://example.com/1'}], NOW)
        new = collector.update_cache(old, {'items': [{'title': 'first updated', 'time': NOW, 'url': 'https://example.com/1'},
                                                    {'title': 'second', 'time': NOW + 120}]}, NOW + 120)
        self.assertEqual(len(new['news']), 2)
        self.assertEqual(new['news'][1]['title'], 'first updated')
        self.assertEqual(new['last_success'], new['last_attempt'])

    def test_empty_result_is_not_error_but_malformed_payload_is(self):
        self.assertEqual(collector.update_cache({}, [], NOW)['status'], 'OK')
        self.assertEqual(collector.update_cache({}, {'items': 'invalid'}, NOW)['status'], 'UNAVAILABLE')
        self.assertEqual(collector.update_cache({}, [{'title': 'missing date'}], NOW)['status'], 'UNAVAILABLE')


if __name__ == '__main__':
    unittest.main()
