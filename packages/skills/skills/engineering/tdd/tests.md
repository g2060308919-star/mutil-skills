# 好测试与坏测试

## 好测试

**集成风格**：通过真实公共接口测试行为，而不是 mock 内部部件。

```typescript
// GOOD: 测试可观察行为
test('user can checkout with valid cart', async () => {
  const cart = createCart()
  cart.add(product)
  const result = await checkout(cart, paymentMethod)

  expect(result.status).toBe('confirmed')
})
```

特征：

- 测试用户或调用方真正关心的行为。
- 只使用公共 API。
- 能经受内部重构。
- 描述 WHAT，而不是 HOW。
- 每个测试聚焦一个逻辑断言。

## 坏测试

**实现细节测试**：测试与内部结构耦合。

```typescript
// BAD: 测试实现细节
test('checkout calls paymentService.process', async () => {
  const mockPayment = jest.mock(paymentService)
  await checkout(cart, payment)

  expect(mockPayment.process).toHaveBeenCalledWith(cart.total)
})
```

危险信号：

- mock 内部协作者。
- 测试私有方法。
- 断言调用次数或调用顺序。
- 行为没有变化时，重构也会导致测试失败。
- 测试名描述 HOW，而不是 WHAT。
- 绕过接口，用外部手段验证内部效果。

```typescript
// BAD: 绕过接口验证
test('createUser saves to database', async () => {
  await createUser({ name: 'Alice' })
  const row = await db.query('SELECT * FROM users WHERE name = ?', ['Alice'])

  expect(row).toBeDefined()
})

// GOOD: 通过接口验证
test('createUser makes user retrievable', async () => {
  const user = await createUser({ name: 'Alice' })
  const retrieved = await getUser(user.id)

  expect(retrieved.name).toBe('Alice')
})
```

**同义反复测试**：期望值用和实现相同的方式重新计算，因此测试天然会通过。

```typescript
// BAD: 期望值用代码里的同一套算法重新算了一遍
test('calculateTotal sums line items', () => {
  const items = [{ price: 10 }, { price: 5 }]
  const expected = items.reduce((sum, item) => sum + item.price, 0)

  expect(calculateTotal(items)).toBe(expected)
})

// GOOD: 期望值是独立、已知的事实
test('calculateTotal sums line items', () => {
  expect(calculateTotal([{ price: 10 }, { price: 5 }])).toBe(15)
})
```
