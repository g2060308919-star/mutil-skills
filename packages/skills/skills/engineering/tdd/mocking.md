# 什么时候 mock

只在**系统边界**使用 mock：

- 外部 API，例如支付、邮件、第三方服务。
- 数据库，虽然多数场景更推荐测试数据库或内存 fake。
- 时间和随机数。
- 文件系统，视场景而定。

不要 mock：

- 自己拥有的类或模块。
- 内部协作者。
- 任何你可以直接控制的代码。

## 为可 mock 性设计

在系统边界处，设计容易替换的接口。

**1. 使用依赖注入**

把外部依赖传入，而不是在函数内部创建。

```typescript
// Easy to mock
function processPayment(order, paymentClient) {
  return paymentClient.charge(order.total)
}

// Hard to mock
function processPayment(order) {
  const client = new StripeClient(process.env.STRIPE_KEY)

  return client.charge(order.total)
}
```

**2. 优先使用 SDK 风格接口，而不是泛化 fetcher**

为每个外部操作创建具体函数，避免把条件逻辑塞进一个通用 fetch 函数。

```typescript
// GOOD: 每个函数都能独立 mock
const api = {
  getUser: (id) => fetch(`/users/${id}`),
  getOrders: (userId) => fetch(`/users/${userId}/orders`),
  createOrder: (data) => fetch('/orders', { method: 'POST', body: data }),
}

// BAD: mock 里需要写条件逻辑
const api = {
  fetch: (endpoint, options) => fetch(endpoint, options),
}
```

SDK 风格的好处：

- 每个 mock 返回一种明确的数据形状。
- 测试 setup 不需要条件逻辑。
- 更容易看出测试触达了哪些端点。
- 每个端点都有更清晰的类型约束。
