## Goal

検証用 Issue。コードフェンス内の擬似ヘッダを誤認しないことを示す。

```
## Goal
これは中身であってヘッダではない
```

## Constraints

- フェンス内の `##` を header として扱わないこと

## Acceptance Criteria

- [ ] フェンスの開閉が正しく追跡される
