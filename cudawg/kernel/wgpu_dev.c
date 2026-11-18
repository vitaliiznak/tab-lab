// SPDX-License-Identifier: GPL-2.0
/*
 * /dev/wgpu0: forwards cudawg requests from userland to the JS host.
 * write(fd, req, len)  -> runs the request on the host (blocking)
 * read(fd, buf, cap)   -> returns the response of the last write
 *
 * The host call is a Wasm import provided by the JS loader:
 *   imports.cudawg.call(req_ptr, req_len, resp_ptr, resp_cap) -> resp_len
 * Pointers are offsets into the kernel's linear memory.
 */
#include <linux/module.h>
#include <linux/miscdevice.h>
#include <linux/fs.h>
#include <linux/uaccess.h>
#include <linux/vmalloc.h>
#include <linux/mutex.h>
#include <linux/slab.h>

#define CHAN_SIZE (1u << 20) /* must match runtime + JS */

__attribute__((import_module("cudawg"), import_name("call")))
extern int cudawg_host_call(void *req, u32 req_len, void *resp, u32 resp_cap);

static DEFINE_MUTEX(host_lock); /* one request in flight on the shared channel */

struct wgpu_file {
	void *req, *resp;
	u32 resp_len;
};

static int wgpu_open(struct inode *inode, struct file *f)
{
	struct wgpu_file *w = kzalloc(sizeof(*w), GFP_KERNEL);

	if (!w)
		return -ENOMEM;
	w->req = vmalloc(CHAN_SIZE);
	w->resp = vmalloc(CHAN_SIZE);
	if (!w->req || !w->resp) {
		vfree(w->req);
		vfree(w->resp);
		kfree(w);
		return -ENOMEM;
	}
	f->private_data = w;
	return 0;
}

static int wgpu_release(struct inode *inode, struct file *f)
{
	struct wgpu_file *w = f->private_data;

	vfree(w->req);
	vfree(w->resp);
	kfree(w);
	return 0;
}

static ssize_t wgpu_write(struct file *f, const char __user *buf, size_t len, loff_t *off)
{
	struct wgpu_file *w = f->private_data;
	int n;

	if (len < 4 || len > CHAN_SIZE)
		return -EINVAL;
	if (copy_from_user(w->req, buf, len))
		return -EFAULT;
	mutex_lock(&host_lock);
	n = cudawg_host_call(w->req, len, w->resp, CHAN_SIZE);
	mutex_unlock(&host_lock);
	if (n < 4)
		return -EIO;
	w->resp_len = n;
	return len;
}

static ssize_t wgpu_read(struct file *f, char __user *buf, size_t cap, loff_t *off)
{
	struct wgpu_file *w = f->private_data;
	u32 n = min_t(u32, w->resp_len, cap);

	if (copy_to_user(buf, w->resp, n))
		return -EFAULT;
	w->resp_len = 0;
	return n;
}

static const struct file_operations wgpu_fops = {
	.owner = THIS_MODULE,
	.open = wgpu_open,
	.release = wgpu_release,
	.read = wgpu_read,
	.write = wgpu_write,
	.llseek = noop_llseek,
};

static struct miscdevice wgpu_misc = {
	.minor = MISC_DYNAMIC_MINOR,
	.name = "wgpu0",
	.fops = &wgpu_fops,
	.mode = 0666,
};

static int __init wgpu_init(void)
{
	return misc_register(&wgpu_misc);
}
device_initcall(wgpu_init);
MODULE_LICENSE("GPL");
MODULE_DESCRIPTION("cudawg: WebGPU channel for wasm Linux");
