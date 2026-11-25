# Markdown WYSIWYG sample

This file exercises the **WYSIWYG** editor: *italic*, ~~strike~~, `inline code` and a [link](https://example.com).

## Lists

- Bullet one
- Bullet two
  - Nested bullet

1. First
2. Second

- [ ] Open task
- [x] Done task

## Code

```python
def two_sum(nums, target):
    seen = {}
    for i, n in enumerate(nums):
        if target - n in seen:
            return [seen[target - n], i]
        seen[n] = i
```

> A blockquote with a thought.

---

| Problem | Difficulty |
| --- | --- |
| Two Sum | Easy |
| LRU Cache | Medium |
