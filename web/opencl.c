/* SPDX-License-Identifier: GPL-3.0-or-later */
/* A CPU stand-in for the OpenCL that sch's placer (src/lib/sch/sch/Placer.cpp) uses.
 *
 * Loom places the cells of a layout with OpenCL kernels (src/lib/sch/cl/placer.cpp), and exits
 * when no OpenCL device can build them.  A browser has no OpenCL, and placement only runs one
 * kernel, globalStep (Placement::solve: the global step, then legalization on the CPU).  So
 * this implements the OpenCL calls the placer makes, for one CPU "device", with globalStep
 * written in C from the kernel's source.  The other kernels exist (so that the program builds
 * as it does on a GPU) but report an error if run.  Both the web build and, unless
 * NATIVE_OPENCL=system, the native build use it, so that their placements can be compared. */
#define CL_TARGET_OPENCL_VERSION 120
#define CL_USE_DEPRECATED_OPENCL_1_2_APIS
#include <CL/cl.h>

#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct _cl_platform_id { int unused; };
struct _cl_device_id { int unused; };
struct _cl_context { int refs; };
struct _cl_command_queue { int refs; };
struct _cl_program { int refs; };
struct _cl_mem { int refs; size_t size; void *data; };

#define MAX_ARGS 16
struct _cl_kernel {
    int refs;
    char name[64];
    unsigned char args[MAX_ARGS][16];
    size_t sizes[MAX_ARGS];
};

static struct _cl_platform_id platform;
static struct _cl_device_id device;

static cl_int info(const void *value, size_t size, size_t param_value_size, void *param_value, size_t *param_value_size_ret) {
    if (param_value_size_ret) *param_value_size_ret = size;
    if (param_value) {
        if (param_value_size < size) return CL_INVALID_VALUE;
        memcpy(param_value, value, size);
    }
    return CL_SUCCESS;
}

static cl_int text(const char *s, size_t param_value_size, void *param_value, size_t *param_value_size_ret) {
    return info(s, strlen(s) + 1, param_value_size, param_value, param_value_size_ret);
}

cl_int clGetPlatformIDs(cl_uint num_entries, cl_platform_id *platforms, cl_uint *num_platforms) {
    if (num_platforms) *num_platforms = 1;
    if (platforms && num_entries > 0) platforms[0] = &platform;
    return CL_SUCCESS;
}

cl_int clGetPlatformInfo(cl_platform_id p, cl_platform_info param_name, size_t size, void *value, size_t *ret) {
    switch (param_name) {
    case CL_PLATFORM_NAME: return text("Loom CPU placer", size, value, ret);
    case CL_PLATFORM_VENDOR: return text("Loom web build", size, value, ret);
    case CL_PLATFORM_VERSION: return text("OpenCL 1.2 (CPU stand-in)", size, value, ret);
    default: return text("", size, value, ret);
    }
}

cl_int clGetDeviceIDs(cl_platform_id p, cl_device_type type, cl_uint num_entries, cl_device_id *devices, cl_uint *num_devices) {
    if (num_devices) *num_devices = 1;
    if (devices && num_entries > 0) devices[0] = &device;
    return CL_SUCCESS;
}

cl_int clGetDeviceInfo(cl_device_id d, cl_device_info param_name, size_t size, void *value, size_t *ret) {
    cl_uint units = 1;
    size_t group = 1;
    cl_ulong memory = 1ull << 30;
    cl_device_type type = CL_DEVICE_TYPE_CPU;
    switch (param_name) {
    case CL_DEVICE_NAME: return text("CPU", size, value, ret);
    case CL_DEVICE_MAX_COMPUTE_UNITS: return info(&units, sizeof units, size, value, ret);
    case CL_DEVICE_MAX_WORK_GROUP_SIZE: return info(&group, sizeof group, size, value, ret);
    case CL_DEVICE_GLOBAL_MEM_SIZE: return info(&memory, sizeof memory, size, value, ret);
    case CL_DEVICE_TYPE: return info(&type, sizeof type, size, value, ret);
    case CL_DEVICE_PLATFORM: { cl_platform_id p = &platform; return info(&p, sizeof p, size, value, ret); }
    case CL_DEVICE_VERSION: return text("OpenCL 1.2", size, value, ret);
    default: return text("", size, value, ret);
    }
}

cl_int clRetainDevice(cl_device_id d) { return CL_SUCCESS; }
cl_int clReleaseDevice(cl_device_id d) { return CL_SUCCESS; }

cl_context clCreateContext(const cl_context_properties *properties, cl_uint num_devices, const cl_device_id *devices,
        void (CL_CALLBACK *notify)(const char *, const void *, size_t, void *), void *user_data, cl_int *errcode_ret) {
    cl_context c = calloc(1, sizeof *c);
    c->refs = 1;
    if (errcode_ret) *errcode_ret = CL_SUCCESS;
    return c;
}

cl_int clGetContextInfo(cl_context c, cl_context_info param_name, size_t size, void *value, size_t *ret) {
    cl_device_id d = &device;
    cl_uint one = 1;
    switch (param_name) {
    case CL_CONTEXT_DEVICES: return info(&d, sizeof d, size, value, ret);
    case CL_CONTEXT_NUM_DEVICES: return info(&one, sizeof one, size, value, ret);
    default: return info(&one, 0, size, value, ret);
    }
}

cl_int clReleaseContext(cl_context c) {
    if (c && --c->refs == 0) free(c);
    return CL_SUCCESS;
}

cl_command_queue clCreateCommandQueue(cl_context c, cl_device_id d, cl_command_queue_properties properties, cl_int *errcode_ret) {
    cl_command_queue q = calloc(1, sizeof *q);
    q->refs = 1;
    if (errcode_ret) *errcode_ret = CL_SUCCESS;
    return q;
}

cl_int clReleaseCommandQueue(cl_command_queue q) {
    if (q && --q->refs == 0) free(q);
    return CL_SUCCESS;
}

cl_int clFinish(cl_command_queue q) { return CL_SUCCESS; }

cl_program clCreateProgramWithSource(cl_context c, cl_uint count, const char **strings, const size_t *lengths, cl_int *errcode_ret) {
    cl_program p = calloc(1, sizeof *p);
    p->refs = 1;
    if (errcode_ret) *errcode_ret = CL_SUCCESS;
    return p;
}

cl_int clBuildProgram(cl_program p, cl_uint num_devices, const cl_device_id *devices, const char *options,
        void (CL_CALLBACK *notify)(cl_program, void *), void *user_data) {
    if (notify) notify(p, user_data);
    return CL_SUCCESS;
}

cl_int clGetProgramInfo(cl_program p, cl_program_info param_name, size_t size, void *value, size_t *ret) {
    cl_device_id d = &device;
    cl_uint one = 1;
    switch (param_name) {
    case CL_PROGRAM_DEVICES: return info(&d, sizeof d, size, value, ret);
    case CL_PROGRAM_NUM_DEVICES: return info(&one, sizeof one, size, value, ret);
    default: return info(&one, 0, size, value, ret);
    }
}

cl_int clGetProgramBuildInfo(cl_program p, cl_device_id d, cl_program_build_info param_name, size_t size, void *value, size_t *ret) {
    return text("", size, value, ret);
}

cl_int clReleaseProgram(cl_program p) {
    if (p && --p->refs == 0) free(p);
    return CL_SUCCESS;
}

cl_kernel clCreateKernel(cl_program p, const char *kernel_name, cl_int *errcode_ret) {
    cl_kernel k = calloc(1, sizeof *k);
    k->refs = 1;
    snprintf(k->name, sizeof k->name, "%s", kernel_name);
    if (errcode_ret) *errcode_ret = CL_SUCCESS;
    return k;
}

cl_int clGetKernelWorkGroupInfo(cl_kernel k, cl_device_id d, cl_kernel_work_group_info param_name, size_t size, void *value, size_t *ret) {
    size_t one = 1;
    return info(&one, sizeof one, size, value, ret);
}

cl_int clSetKernelArg(cl_kernel k, cl_uint index, size_t size, const void *value) {
    if (index >= MAX_ARGS || size > sizeof k->args[0]) return CL_INVALID_ARG_INDEX;
    memset(k->args[index], 0, sizeof k->args[index]);
    if (value) memcpy(k->args[index], value, size);
    k->sizes[index] = size;
    return CL_SUCCESS;
}

cl_int clReleaseKernel(cl_kernel k) {
    if (k && --k->refs == 0) free(k);
    return CL_SUCCESS;
}

cl_mem clCreateBuffer(cl_context c, cl_mem_flags flags, size_t size, void *host_ptr, cl_int *errcode_ret) {
    cl_mem m = calloc(1, sizeof *m);
    m->refs = 1;
    m->size = size;
    m->data = calloc(1, size ? size : 1);
    if (host_ptr && (flags & CL_MEM_COPY_HOST_PTR)) memcpy(m->data, host_ptr, size);
    if (errcode_ret) *errcode_ret = CL_SUCCESS;
    return m;
}

cl_int clReleaseMemObject(cl_mem m) {
    if (m && --m->refs == 0) {
        free(m->data);
        free(m);
    }
    return CL_SUCCESS;
}

cl_int clEnqueueWriteBuffer(cl_command_queue q, cl_mem m, cl_bool blocking, size_t offset, size_t size, const void *ptr,
        cl_uint num_events, const cl_event *wait_list, cl_event *event) {
    if (offset + size > m->size) return CL_INVALID_VALUE;
    memcpy((char *)m->data + offset, ptr, size);
    return CL_SUCCESS;
}

cl_int clEnqueueReadBuffer(cl_command_queue q, cl_mem m, cl_bool blocking, size_t offset, size_t size, void *ptr,
        cl_uint num_events, const cl_event *wait_list, cl_event *event) {
    if (offset + size > m->size) return CL_INVALID_VALUE;
    memcpy(ptr, (char *)m->data + offset, size);
    return CL_SUCCESS;
}

/* ----- The kernels */

/* cartesianFromHilbert from placer.cpp, for n at most 32. */
static void cartesianFromHilbert(cl_ulong s, int n, cl_uint *x, cl_uint *y) {
    cl_uint vx = 0, vy = 0;
    unsigned char state = 0;
    for (int i = 2 * (n - 1); i >= 0; i -= 2) {
        unsigned char row = 4 * state | (unsigned char)((s >> i) & 3);
        vx = (vx << 1) | ((0x936C >> row) & 1);
        vy = (vy << 1) | ((0x39C6 >> row) & 1);
        state = (0x3E6B94C1u >> 2 * row) & 3;
    }
    *x = vx;
    *y = vy;
}

#define ARG(k, i, type) (*(type *)(k)->args[i])
#define BUF(k, i, type) ((type *)ARG(k, i, cl_mem)->data)

/* globalStep: spread the cells along the Hilbert curve, in proportion to their area. */
static void globalStep(cl_kernel k, size_t i) {
    cl_uint4 *position = BUF(k, 0, cl_uint4);    /* uint3 in OpenCL C: four words */
    cl_ulong *hilbert = BUF(k, 1, cl_ulong);
    cl_uint num = ARG(k, 2, cl_uint);
    cl_ulong total = ARG(k, 3, cl_ulong);
    cl_uint scale = ARG(k, 4, cl_uint);
    if (i >= num) return;
    cl_ulong h = hilbert[i] * (ULONG_MAX / total);
    if (scale == 0) {
        position[i].s[0] = 0;
        position[i].s[1] = 0;
    } else {
        cl_uint x, y;
        cartesianFromHilbert(h, 32, &x, &y);
        position[i].s[0] = x / scale;
        position[i].s[1] = y / scale;
    }
    position[i].s[2] = (cl_uint)i;
}

cl_int clEnqueueNDRangeKernel(cl_command_queue q, cl_kernel k, cl_uint work_dim, const size_t *global_work_offset,
        const size_t *global_work_size, const size_t *local_work_size, cl_uint num_events, const cl_event *wait_list, cl_event *event) {
    size_t n = 1;
    for (cl_uint d = 0; d < work_dim; d++) n *= global_work_size[d];
    if (strcmp(k->name, "globalStep") == 0) {
        for (size_t i = 0; i < n; i++) globalStep(k, i);
        return CL_SUCCESS;
    }
    fprintf(stderr, "error: the placer's %s kernel needs a real OpenCL device, which this build doesn't have\n", k->name);
    return CL_INVALID_KERNEL;
}
